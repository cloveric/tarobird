package com.tarobot.client;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.SocketAddress;
import java.net.SocketException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.Socket;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import javax.net.SocketFactory;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import org.java_websocket.WebSocket;
import org.java_websocket.WebSocketImpl;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.drafts.Draft;
import org.java_websocket.drafts.Draft_6455;
import org.java_websocket.enums.HandshakeState;
import org.java_websocket.enums.Opcode;
import org.java_websocket.exceptions.IncompleteHandshakeException;
import org.java_websocket.exceptions.InvalidDataException;
import org.java_websocket.exceptions.InvalidHandshakeException;
import org.java_websocket.framing.CloseFrame;
import org.java_websocket.framing.Framedata;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.handshake.Handshakedata;
import org.java_websocket.handshake.ServerHandshake;

/** Bounded RFC 6455 decoding over the same identity-pinned TLS factory as HTTP.
 * No extensions, redirects, proxy, cookies, authentication replay or reconnect.
 * The library version is pinned: its public outQueue is inspected only to bound
 * writes (including automatic pongs); no reflection or private internals. */
final class HubSocket extends WebSocketClient {
    interface Listener {
        void opened();
        void message(String text);
        void closed(int code, String reason, boolean clean);
        void failed(Exception error);
    }
    static final int HANDSHAKE_LIMIT = 16 * 1024, FRAGMENT_LIMIT = 4096;
    static final int WRITE_LIMIT = 2 * HubTls.MAX_FRAME, WRITE_FRAMES = 64;
    private static final class Receipt {
        volatile boolean peerClose, closeWritten, invalid, localCloseSent;
        volatile int code = 1006;
        volatile String reason = "";
    }
    static final class BoundedDraft extends Draft_6455 {
        final Receipt receipt;
        long messageBytes;
        int fragments, headerBytes, extendedBytes, lengthBytes;
        long payloadLength, remainingPayload;
        BoundedDraft() { this(new Receipt()); }
        private BoundedDraft(Receipt receipt) { super(Collections.emptyList(), HubTls.MAX_FRAME); this.receipt=receipt; }
        @Override public Draft copyInstance() { return new BoundedDraft(receipt); }
        @Override public Handshakedata translateHandshake(ByteBuffer input) throws InvalidHandshakeException {
            // Scan only the HTTP header; a valid upgrade may share its read with
            // the first data frame. Never reject that frame as header overflow.
            int start=input.position(), end=Math.min(input.limit(),start+HANDSHAKE_LIMIT);
            for(int i=start;i+3<end;i++) if(input.get(i)==13 && input.get(i+1)==10 && input.get(i+2)==13 && input.get(i+3)==10) return super.translateHandshake(input);
            if(input.remaining()>=HANDSHAKE_LIMIT) throw new InvalidHandshakeException("native_socket_handshake_too_large");
            throw new IncompleteHandshakeException();
        }
        @Override public HandshakeState acceptHandshakeAsClient(ClientHandshake request, ServerHandshake response) throws InvalidHandshakeException {
            if(!response.getFieldValue("Sec-WebSocket-Extensions").trim().isEmpty() || !response.getFieldValue("Sec-WebSocket-Protocol").trim().isEmpty()) throw new InvalidHandshakeException("unexpected_websocket_extension");
            return super.acceptHandshakeAsClient(request,response);
        }
        private void checkWireHeaders(ByteBuffer input) throws InvalidDataException {
            ByteBuffer scan=input.duplicate();
            while(scan.hasRemaining()) {
                if(remainingPayload>0) { int skip=(int)Math.min(remainingPayload,scan.remaining()); scan.position(scan.position()+skip); remainingPayload-=skip; continue; }
                if(headerBytes==0) { scan.get(); headerBytes=1; continue; }
                if(headerBytes==1) {
                    int second=scan.get()&255;
                    // 1.6.0 strips the mask but does not preserve that bit in
                    // Framedata. Check the wire header before its decoder.
                    if((second&128)!=0) throw new InvalidDataException(1002,"masked_server_frame");
                    int size=second&127;
                    if(size<126) { remainingPayload=size; headerBytes=0; }
                    else { headerBytes=2; extendedBytes=lengthBytes=size==126?2:8; payloadLength=0; }
                    continue;
                }
                payloadLength=(payloadLength<<8)|(scan.get()&255);
                if(payloadLength>HubTls.MAX_FRAME) throw new InvalidDataException(1009,"native_socket_frame_too_large");
                if(--lengthBytes==0) {
                    if((extendedBytes==2 && payloadLength<126) || (extendedBytes==8 && payloadLength<65536)) throw new InvalidDataException(1002,"nonminimal_frame_length");
                    remainingPayload=payloadLength; headerBytes=0;
                }
            }
        }
        @Override public List<Framedata> translateFrame(ByteBuffer input) throws InvalidDataException {
            try { checkWireHeaders(input); return super.translateFrame(input); }
            catch(InvalidDataException error) { receipt.invalid=true; throw error; }
        }
        @Override public void processFrame(WebSocketImpl socket, Framedata frame) throws InvalidDataException {
            try {
                if(receipt.peerClose) return;
                Opcode op=frame.getOpcode();
                if(op==Opcode.TEXT || op==Opcode.BINARY || op==Opcode.CONTINUOUS) {
                    // The library bounds individual frames before allocating,
                    // but non-final continuation frames also need a total bound.
                    messageBytes+=frame.getPayloadData().remaining(); fragments++;
                    if(messageBytes>HubTls.MAX_FRAME || fragments>FRAGMENT_LIMIT) throw new InvalidDataException(1009,"native_socket_message_too_large");
                    if(frame.isFin()) { messageBytes=0; fragments=0; }
                }
                if(op==Opcode.CLOSING && frame instanceof CloseFrame) {
                    CloseFrame close=(CloseFrame)frame;
                    boolean reply;
                    synchronized(receipt) { receipt.code=close.getCloseCode(); receipt.reason=close.getMessage(); receipt.peerClose=true; reply=receipt.localCloseSent; }
                    if(reply) { socket.closeConnection(receipt.code,receipt.reason,true); return; }
                }
                super.processFrame(socket,frame);
            } catch(InvalidDataException error) { receipt.invalid=true; throw error; }
        }
        @Override public void reset() { super.reset(); messageBytes=0; fragments=0; headerBytes=extendedBytes=lengthBytes=0; payloadLength=remainingPayload=0; }
    }
    private final HubTls.Route route;
    private final Listener listener;
    private final Receipt receipt;
    private final ScheduledExecutorService deadlines;
    private final Object lifecycle = new Object(), writes = new Object();
    private volatile Socket wire, tcp;
    private volatile boolean cancelled, localClosing, opened;
    private boolean protocolClosed, finished, failureReported;
    private ScheduledFuture<?> timeout;
    HubSocket(HubTls.Route route, Listener listener, ScheduledExecutorService deadlines) {
        this(route,listener,deadlines,new BoundedDraft());
    }
    private HubSocket(HubTls.Route route, Listener listener, ScheduledExecutorService deadlines, BoundedDraft draft) {
        super(URI.create(route.base.newBuilder().encodedPath("/ws").build().toString().replaceFirst("^https:","wss:")),draft);
        this.route=route; this.listener=listener; this.deadlines=deadlines; this.receipt=draft.receipt;
        setProxy(Proxy.NO_PROXY); setConnectionLostTimeout(0); setDaemon(true);
    }
    private void attach(Socket socket) throws IOException {
        synchronized(lifecycle) { if(cancelled) { socket.close(); throw new IOException("native_request_cancelled"); } wire=socket; if(!(socket instanceof SSLSocket)) tcp=socket; }
    }
    /** Called on the bridge's bounded IO pool, not a newly spawned DNS thread. */
    void start() {
        try {
            synchronized(lifecycle) { if(cancelled) return; timeout=deadlines.schedule(()->fail(new IOException("native_socket_open_timeout"),true),10,TimeUnit.SECONDS); }
            Socket raw=null; IOException connectionFailure=null; long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
            // Match the HTTP client's resolver and try alternative addresses
            // within one deadline; a broken first IPv6 route must not strand WS.
            for(InetAddress address:route.client.dns().lookup(route.base.host())) {
                long remaining=TimeUnit.NANOSECONDS.toMillis(until-System.nanoTime());
                if(remaining<=0 || cancelled) break;
                Socket attempt=new Socket(Proxy.NO_PROXY); attach(attempt);
                try { attempt.connect(new InetSocketAddress(address,route.base.port()),(int)Math.max(1,Math.min(2000,remaining))); raw=attempt; break; }
                catch(IOException error) { connectionFailure=error; attempt.close(); }
            }
            if(raw==null) throw connectionFailure!=null?connectionFailure:new IOException("native_socket_connect_timeout");
            SSLSocket tls=(SSLSocket)route.client.sslSocketFactory().createSocket(raw,route.base.host(),route.base.port(),true); attach(tls);
            List<String> protocols=new ArrayList<>(); for(String protocol:tls.getSupportedProtocols()) if(protocol.equals("TLSv1.2") || protocol.equals("TLSv1.3")) protocols.add(protocol);
            tls.setEnabledProtocols(protocols.toArray(new String[0]));
            SSLParameters parameters=tls.getSSLParameters(); parameters.setEndpointIdentificationAlgorithm("HTTPS"); tls.setSSLParameters(parameters);
            tls.setSoTimeout(5000); tls.startHandshake();
            if(!route.client.hostnameVerifier().verify(route.base.host(),tls.getSession())) throw new javax.net.ssl.SSLPeerUnverifiedException("native_tls_host_mismatch");
            // Supply an already verified, connected socket through the public
            // factory API. The library does not create another TLS connection.
            setSocketFactory(new SocketFactory() {
                public Socket createSocket() throws IOException { synchronized(lifecycle) { if(cancelled) throw new IOException("native_request_cancelled"); return new VerifiedStreamSocket(tls); } }
                public Socket createSocket(String h,int p) throws IOException { throw new IOException("unsupported_socket_creation"); }
                public Socket createSocket(String h,int p,InetAddress l,int q) throws IOException { throw new IOException("unsupported_socket_creation"); }
                public Socket createSocket(InetAddress h,int p) throws IOException { throw new IOException("unsupported_socket_creation"); }
                public Socket createSocket(InetAddress h,int p,InetAddress l,int q) throws IOException { throw new IOException("unsupported_socket_creation"); }
            });
            synchronized(lifecycle) { if(!cancelled) connect(); }
        } catch(Exception error) { fail(error,false); releaseTls(); }
    }
    void cancel() {
        Socket socket;
        synchronized(lifecycle) { cancelled=true; socket=tcp; if(timeout!=null) timeout.cancel(false); }
        if(socket!=null) try { socket.close(); } catch(IOException | RuntimeException ignored) { }
        finishClose();
    }
    // Closing SSLSocket directly may wait for close_notify behind a blocked
    // TLS writer. Abort its underlying TCP socket first; control must not wait
    // for a peer that stopped reading. TLS disposal runs on the IO callback.
    private void releaseTls() { Socket socket=wire; if(socket!=null) try { socket.close(); } catch(IOException | RuntimeException ignored) { } }
    /** TLS is fully established and verified before this adapter is handed to
     * the RFC 6455 library. It exposes only that SSLSocket's encrypted streams.
     * Observe the writer's flush so clean means BOTH a received peer Close and
     * a written local Close, even when the peer stops consuming our data. */
    private final class VerifiedStreamSocket extends Socket {
        final SSLSocket tls;
        final OutputStream output;
        VerifiedStreamSocket(SSLSocket tls) throws IOException {
            this.tls=tls; OutputStream target=tls.getOutputStream();
            output=new OutputStream() {
                boolean pendingClose;
                public void write(int b) throws IOException { target.write(b); }
                public void write(byte[] bytes,int offset,int length) throws IOException {
                    target.write(bytes,offset,length);
                    // Java-WebSocket 1.6.0 writes exactly one encoded frame per
                    // call and then flushes; its HTTP upgrade is a separate call.
                    if(length>=6 && length<=131 && (bytes[offset]&255)==0x88 && (bytes[offset+1]&128)!=0) pendingClose=true;
                }
                public void flush() throws IOException {
                    target.flush();
                    if(pendingClose) { receipt.closeWritten=true; pendingClose=false; finishClose(); }
                }
            };
        }
        @Override public InputStream getInputStream() throws IOException { return tls.getInputStream(); }
        @Override public OutputStream getOutputStream() { return output; }
        @Override public boolean isConnected() { return tls.isConnected(); }
        @Override public boolean isClosed() { return cancelled || tls.isClosed(); }
        @Override public void close() { cancel(); releaseTls(); }
        @Override public void setTcpNoDelay(boolean value) throws SocketException { tls.setTcpNoDelay(value); }
        @Override public void setReuseAddress(boolean value) throws SocketException { tls.setReuseAddress(value); }
        @Override public InetAddress getInetAddress() { return tls.getInetAddress(); }
        @Override public InetAddress getLocalAddress() { return tls.getLocalAddress(); }
        @Override public int getPort() { return tls.getPort(); }
        @Override public int getLocalPort() { return tls.getLocalPort(); }
        @Override public SocketAddress getRemoteSocketAddress() { return tls.getRemoteSocketAddress(); }
        @Override public SocketAddress getLocalSocketAddress() { return tls.getLocalSocketAddress(); }
    }
    private void finishClose() {
        boolean clean;
        synchronized(lifecycle) {
            if(finished || !protocolClosed) return;
            clean=receipt.peerClose && receipt.closeWritten && !receipt.invalid && !cancelled;
            if(!clean && !receipt.invalid && !cancelled && receipt.peerClose) return;
            finished=true; if(timeout!=null) timeout.cancel(false);
        }
        listener.closed(clean?receipt.code:1006,clean?receipt.reason:"",clean);
        cancel(); ((WebSocketImpl)getConnection()).outQueue.clear();
    }
    private boolean room(int bytes) {
        long total=bytes+14; int count=0;
        for(ByteBuffer buffer:((WebSocketImpl)getConnection()).outQueue) { total+=buffer.remaining(); if(++count>=WRITE_FRAMES || total>WRITE_LIMIT) return false; }
        return total<=WRITE_LIMIT;
    }
    boolean sendText(String text) {
        synchronized(writes) {
            if(cancelled || localClosing || !opened || !isOpen() || !room(text.getBytes(StandardCharsets.UTF_8).length)) return false;
            try { send(text); return true; } catch(RuntimeException error) { return false; }
        }
    }
    boolean beginClose(int code,String reason) {
        synchronized(writes) {
            if(cancelled || localClosing || !opened || !isOpen()) return false;
            localClosing=true;
            try {
                // Keep the reader alive until an actual peer Close or deadline.
                // WebSocketClient.close() stops its read loop before the reply.
                CloseFrame frame=new CloseFrame(); frame.setCode(code); frame.setReason(reason); frame.isValid();
                if(!room(125)) { cancel(); return false; }
                synchronized(receipt) { if(receipt.peerClose) return false; receipt.localCloseSent=true; }
                sendFrame(frame);
                synchronized(lifecycle) { if(!cancelled) timeout=deadlines.schedule(this::cancel,5,TimeUnit.SECONDS); }
                return true;
            } catch(Exception error) { cancel(); return false; }
        }
    }
    @Override public void onWebsocketPing(WebSocket socket, Framedata frame) {
        synchronized(writes) { if(cancelled || localClosing) return; if(!room(125)) { cancel(); return; } super.onWebsocketPing(socket,frame); }
    }
    @Override public void onOpen(ServerHandshake handshake) {
        try {
            synchronized(lifecycle) { if(cancelled) return; wire.setSoTimeout(0); if(timeout!=null) timeout.cancel(false); opened=true; }
            listener.opened();
        } catch(IOException error) { fail(error,false); }
    }
    @Override public void onMessage(String text) { if(!cancelled && !localClosing) listener.message(text); }
    @Override public void onMessage(ByteBuffer bytes) { fail(new IOException("binary_websocket_message"),false); }
    private void fail(Exception error,boolean openingDeadline) {
        synchronized(lifecycle) {
            if(finished || failureReported || cancelled || (openingDeadline && opened) || (receipt.peerClose && receipt.closeWritten)) return;
            failureReported=true; receipt.invalid=true;
        }
        cancel(); listener.failed(error);
    }
    @Override public void onError(Exception error) { fail(error,false); }
    @Override public void onClose(int code,String reason,boolean remote) {
        synchronized(lifecycle) {
            protocolClosed=true;
            if(!receipt.peerClose) receipt.invalid=true;
            if(!finished && !cancelled && receipt.peerClose && !receipt.closeWritten) {
                if(timeout!=null) timeout.cancel(false);
                timeout=deadlines.schedule(this::cancel,5,TimeUnit.SECONDS);
            }
        }
        finishClose();
    }
}
