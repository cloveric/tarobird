package com.tarobot.client;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import org.json.JSONObject;

/** One document-owned, viewer-only pair of pinned sockets. All mutable state
 * uses the owning transport monitor, including callbacks and lifecycle gates.
 * No binary data enters the Capacitor event queue: native packets are retained
 * only until strict sequential pulls and an explicit consumption ACK, at most
 * BINARY_WINDOW of the current stream generation and BINARY_RETAINED in all. */
final class HubScreenSession {
    static final int PACKET_LIMIT=1024*1024, READ_LIMIT=256*1024, CONTROL_LIMIT=16384;
    static final long ACK_NANOS=TimeUnit.SECONDS.toNanos(2);
    /** The target's flight window: the most frames of one stream generation it keeps
     * unacknowledged (three by default, up to this many for a viewer that names its
     * capacity; the page asks for this value through screenWindow). A restart (start
     * control, keyframe, resume) retires them and the next generation may send a full
     * window while the page still reads the old one's, so superseded packets count only
     * against the total: one current window plus one superseded window. JSON deliveries,
     * commands queued before the control socket is ready and frames waiting in a screen
     * socket's write queue (HubSocket) are bounded five beyond the window: a frame-ready
     * and a receipt per frame, plus state and input. */
    static final int BINARY_WINDOW=16, BINARY_RETAINED=2*BINARY_WINDOW, PENDING=BINARY_WINDOW+5;
    interface Events { void send(JSONObject event) throws Exception; void closed(); }
    private static final class Delivery {
        final byte[] bytes; final int size; final long generation, sent=System.nanoTime(); int offset;
        Delivery(byte[] bytes,int size,long generation) { this.bytes=bytes; this.size=size; this.generation=generation; }
    }
    private final Object owner;
    private final BooleanSupplier active;
    private final Events events;
    private final ScheduledExecutorService deadlines;
    private final String id, document, sessionId, generation, desktopId, displayId;
    private final long displayRevision;
    private final boolean controlAllowed;
    private final int edgeLimit, areaLimit;
    private final boolean h264Only;
    private final Map<Long,Delivery> deliveries=new LinkedHashMap<>();
    private final ArrayList<String> outgoing=new ArrayList<>();
    private HubSocket control,media;
    private boolean closed, controlReady,mediaReady, visible=true,inputFocused,canControl;
    private String controlTicket,mediaTicket;
    private int jsonCount,jsonBytes,binaryCount,outgoingBytes;
    private long sequence,lastFrame,streamGeneration,geometryRevision;
    private int width,height,codec;
    private long controlActivity=System.nanoTime(),mediaActivity=controlActivity;
    private ScheduledFuture<?> attachmentDeadline,watchdog;

    HubScreenSession(Object owner,String id,String document,JSONObject join,BooleanSupplier active,Events events,ScheduledExecutorService deadlines) throws Exception {
        this.owner=owner; this.id=id; this.document=document; this.active=active; this.events=events; this.deadlines=deadlines;
        if(join==null||join.toString().getBytes(StandardCharsets.UTF_8).length>CONTROL_LIMIT) throw invalid();
        keys(join,"session controlTicket mediaTicket expiresAt serverTime","quality");
        JSONObject session=object(join,"session"), display=object(session,"display");
        sessionId=identifier(session,"id"); generation=identifier(session,"generation"); desktopId=identifier(session,"desktopId");
        displayId=identifier(display,"id"); displayRevision=integer(display,"revision",1,0xffffffffL);
        controlAllowed=bool(session,"controlAllowed");
        controlTicket=token(join,"controlTicket"); mediaTicket=token(join,"mediaTicket");
        long expires=integer(join,"expiresAt",0,9007199254740991L), now=integer(join,"serverTime",0,9007199254740991L);
        if(expires<=now || expires-now>30000 || controlTicket.equals(mediaTicket)) throw invalid();
        String quality=join.has("quality")?text(join,"quality"):"balanced";
        if(!Arrays.asList("smooth","balanced","sharp").contains(quality)) throw invalid();
        edgeLimit=quality.equals("smooth")?1280:quality.equals("sharp")?3072:1920;
        areaLimit=quality.equals("smooth")?1280*800:quality.equals("sharp")?3072*1920:1920*1080;
        h264Only=quality.equals("sharp");
    }
    private static IOException invalid() { return new IOException("screen_protocol_invalid"); }
    /** A well-formed renew or input after native has seen control end (the Hub withdrew the
     * lease, or focus was lost): refused and never forwarded. The page may simply not have
     * processed that state yet, so this ends control, not the session. */
    private static IOException controlEnded() { return new IOException("screen_control_ended"); }
    static String text(JSONObject object,String key) throws IOException { Object value=object.opt(key); if(!(value instanceof String)) throw invalid(); return (String)value; }
    static JSONObject object(JSONObject object,String key) throws IOException { Object value=object.opt(key); if(!(value instanceof JSONObject)) throw invalid(); return (JSONObject)value; }
    private static String identifier(JSONObject object,String key) throws IOException { String value=text(object,key); if(!value.matches("[A-Za-z0-9_-]{1,128}")) throw invalid(); return value; }
    private static String token(JSONObject object,String key) throws IOException { String value=text(object,key); if(!value.matches("[A-Za-z0-9_-]{43}")) throw invalid(); return value; }
    private static boolean bool(JSONObject object,String key) throws IOException { Object value=object.opt(key); if(!(value instanceof Boolean)) throw invalid(); return (Boolean)value; }
    private static double number(JSONObject object,String key,double min,double max) throws IOException { Object raw=object.opt(key); if(!(raw instanceof Number)) throw invalid(); double value=((Number)raw).doubleValue(); if(!Double.isFinite(value)||value<min||value>max) throw invalid(); return value; }
    static long integer(JSONObject object,String key,long min,long max) throws IOException { double value=number(object,key,min,max); if(value!=Math.floor(value)) throw invalid(); return (long)value; }
    private static void keys(JSONObject object,String required,String optional) throws IOException {
        for(String name:required.split(" ")) if(!name.isEmpty()&&!object.has(name)) throw invalid();
        java.util.Iterator<String> names=object.keys(); String permitted=" "+required+" "+optional+" ";
        while(names.hasNext()) if(!permitted.contains(" "+names.next()+" ")) throw invalid();
    }
    private boolean live() { return !closed && active.getAsBoolean(); }
    private void requireLive() throws IOException { if(!live()) { close("screen_inactive"); throw new IOException("screen_inactive"); } }
    boolean isOpen() { synchronized(owner) { return !closed; } }
    void start(HubTls.Route route,Runnable trustFailed) throws Exception {
        synchronized(owner) {
            requireLive();
            control=new HubSocket(route,listener(false,trustFailed),deadlines,false);
            media=new HubSocket(route,listener(true,trustFailed),deadlines,true);
            attachmentDeadline=deadlines.schedule(()->{ synchronized(owner) { close("screen_connect_timeout"); } },10,TimeUnit.SECONDS);
            watchdog=deadlines.scheduleAtFixedRate(()->{ synchronized(owner) {
                if(!live()) { close("screen_inactive"); return; }
                long now=System.nanoTime();
                for(Delivery value:deliveries.values()) if(now-value.sent>ACK_NANOS) { close("screen_viewer_congested"); return; }
                if(now-controlActivity>TimeUnit.SECONDS.toNanos(15)||now-mediaActivity>TimeUnit.SECONDS.toNanos(15)) close("screen_network_timeout");
            } },250,250,TimeUnit.MILLISECONDS);
        }
        control.start();
        synchronized(owner) { requireLive(); }
        media.start();
    }
    private HubSocket.Listener listener(boolean isMedia,Runnable trustFailed) {
        return new HubSocket.Listener() {
            public void opened() { synchronized(owner) { try {
                requireLive(); String ticket=isMedia?mediaTicket:controlTicket;
                if(isMedia) mediaTicket=null; else controlTicket=null;
                if(ticket==null || !(isMedia?media:control).sendText(new JSONObject().put("type","hello").put("ticket",ticket).toString())) close("screen_control_closed");
            } catch(Exception error) { close("screen_open_failed"); } } }
            public void activity() { synchronized(owner) { if(isMedia) mediaActivity=System.nanoTime(); else controlActivity=System.nanoTime(); } }
            public void message(String text) { synchronized(owner) { try { requireLive(); receive(isMedia,text); } catch(Exception error) { close("screen_protocol_invalid"); } } }
            public void binary(ByteBuffer bytes) { synchronized(owner) { try { requireLive(); if(!isMedia) throw invalid(); receiveBinary(bytes); } catch(Exception error) { close("screen_protocol_invalid"); } } }
            public void closed(int code,String reason,boolean clean) { synchronized(owner) { close(hostCloseReason(code,reason,clean)); } }
            public void failed(Exception error) { synchronized(owner) { close("screen_network_closed"); } if(HubTls.trustFailure(error)) trustFailed.run(); }
        };
    }
    /** A clean Host close keeps its bounded screen_ reason, or one of the exact
     * sign-in codes the Host also ends a session with; anything else is generic. */
    static String hostCloseReason(int code,String reason,boolean clean) {
        if(!clean || code!=4000 || reason==null) return "screen_network_closed";
        if(reason.equals("session_expired") || reason.equals("device_revoked") || reason.equals("device_revoked_or_expired")) return reason;
        return reason.matches("screen_[a-z_]{1,57}") ? reason : "screen_network_closed";
    }
    /** Released Hubs (1.5.1 and earlier) notify the session's state from
     * attachViewer before the control socket replies "attached". Only the control
     * socket may hold such states: each fully valid for this session, at most
     * EARLY_STATES messages and EARLY_STATE_BYTES in total. They grant and deliver
     * nothing until "attached", then follow it in arrival order through the same
     * state path, so control grant, delivery budgets and the attach deadline are
     * unchanged. A missing or wrong "attached" still ends the session. */
    static final int EARLY_STATES=4, EARLY_STATE_BYTES=16384;
    private final ArrayList<JSONObject> early=new ArrayList<>(); private final ArrayList<Integer> earlySizes=new ArrayList<>(); private int earlyBytes;
    private void receive(boolean isMedia,String text) throws Exception {
        int size=text.getBytes(StandardCharsets.UTF_8).length; if(size>CONTROL_LIMIT) throw invalid();
        JSONObject value=new JSONObject(text); String type=text(value,"type");
        if(!isMedia && !controlReady && type.equals("state")) {
            if(early.size()>=EARLY_STATES || earlyBytes+size>EARLY_STATE_BYTES) throw invalid();
            controlGrant(value); early.add(value); earlySizes.add(size); earlyBytes+=size; return;
        }
        if(type.equals("attached")) {
            keys(value,"type sessionId",""); if(!sessionId.equals(text(value,"sessionId")) || (isMedia?mediaReady:controlReady)) throw invalid();
            if(isMedia) { mediaReady=true; if(controlReady) attachmentDeadline.cancel(false); return; }
            controlReady=true; if(mediaReady) attachmentDeadline.cancel(false);
            if(!deliver(value,size)) return;
            ArrayList<JSONObject> held=new ArrayList<>(early); ArrayList<Integer> sizes=new ArrayList<>(earlySizes); early.clear(); earlySizes.clear(); earlyBytes=0;
            for(int i=0;i<held.size();i++) { applyState(held.get(i)); if(!deliver(held.get(i),sizes.get(i))) return; }
            for(String queued:outgoing) if(!control.sendText(queued)) throw invalid(); outgoing.clear(); outgoingBytes=0;
            return;
        } else if(isMedia) {
            if(!mediaReady || !type.equals("stream")) throw invalid();
            keys(value,"type streamGeneration geometryRevision codec codecString width height contentRect","");
            long stream=integer(value,"streamGeneration",1,0xffffffffL),geometry=integer(value,"geometryRevision",1,0xffffffffL);
            if(streamGeneration!=0 && stream<=streamGeneration) throw invalid();
            int w=(int)integer(value,"width",1,edgeLimit),h=(int)integer(value,"height",1,edgeLimit);
            String c=text(value,"codec"),cs=text(value,"codecString");
            if(!c.equals("h264")&&!c.equals("vp8") || h264Only&&!c.equals("h264") || w*h>areaLimit || (c.equals("h264")?!cs.matches("avc1\\.[0-9a-fA-F]{6}"):!cs.equals("vp8"))) throw invalid();
            JSONObject rect=object(value,"contentRect"); keys(rect,"x y width height","");
            if(integer(rect,"x",0,0)!=0||integer(rect,"y",0,0)!=0||integer(rect,"width",1,edgeLimit)!=w||integer(rect,"height",1,edgeLimit)!=h) throw invalid();
            streamGeneration=stream; geometryRevision=geometry; width=w; height=h; codec=c.equals("h264")?1:2; lastFrame=0;
        } else {
            if(!controlReady) throw invalid();
            if(type.equals("state")) applyState(value);
            else if(type.equals("rtc-frame")) {
                keys(value,"type sessionId generation nonce streamGeneration frameSequence captureMs rtpTimestamp","");
                if(!sessionId.equals(text(value,"sessionId"))||!generation.equals(text(value,"generation"))
                    ||!text(value,"nonce").matches("[A-Za-z0-9_-]{43}")) throw invalid();
                integer(value,"streamGeneration",1,0xffffffffL); integer(value,"frameSequence",0x80000000L,0xffffffffL);
                integer(value,"captureMs",0,9007199254740991L); integer(value,"rtpTimestamp",0,0xffffffffL);
            }
            else if(type.equals("frame-ready")) {
                keys(value,"type sessionId generation streamGeneration frameSequence expiresAt","");
                if(!sessionId.equals(text(value,"sessionId"))||!generation.equals(text(value,"generation"))) throw invalid();
                integer(value,"streamGeneration",1,0xffffffffL); integer(value,"frameSequence",1,0xffffffffL); integer(value,"expiresAt",0,9007199254740991L);
            } else throw invalid();
        }
        deliver(value,size);
    }
    /** Validates a control state for this session and returns the control it grants; changes nothing. */
    private boolean controlGrant(JSONObject value) throws Exception {
        keys(value,"type session serverTime","controlPending streamGeneration lease"); JSONObject session=object(value,"session");
        if(!sessionId.equals(text(session,"id"))||!generation.equals(text(session,"generation"))||!desktopId.equals(text(session,"desktopId"))) throw invalid();
        String state=text(session,"state"); if(!Arrays.asList("connecting","viewing","paused","controlling","closed").contains(state)) throw invalid();
        integer(value,"serverTime",0,9007199254740991L);
        if(value.has("controlPending")) bool(value,"controlPending");
        if(value.has("streamGeneration")) integer(value,"streamGeneration",1,0xffffffffL);
        if(value.has("lease")) { JSONObject lease=object(value,"lease"); keys(lease,"id expiresAt challenge challengeExpiresAt",""); token(lease,"id"); token(lease,"challenge"); integer(lease,"expiresAt",0,9007199254740991L); integer(lease,"challengeExpiresAt",0,9007199254740991L); }
        return state.equals("controlling")&&value.has("lease")&&controlAllowed;
    }
    private void applyState(JSONObject value) throws Exception { canControl=controlGrant(value); if(!canControl) inputFocused=false; }
    /** Queues one JSON delivery for the page; false when the bound closed the session. */
    private boolean deliver(JSONObject value,int size) throws Exception {
        if(jsonCount>=PENDING || jsonBytes+size>65536) { close("screen_viewer_congested"); return false; }
        Delivery delivery=new Delivery(null,size,0); long receipt=++sequence; deliveries.put(receipt,delivery); jsonCount++; jsonBytes+=size;
        emit(new JSONObject().put("kind","screen").put("deliverySequence",receipt).put("value",value));
        return true;
    }
    private void receiveBinary(ByteBuffer raw) throws Exception {
        int length=raw.remaining(); if(!mediaReady||streamGeneration==0||length<=32||length>PACKET_LIMIT) throw invalid();
        ByteBuffer data=raw.slice().order(ByteOrder.LITTLE_ENDIAN);
        int key=data.get(1)&255; long frame=(data.getInt(4)&0xffffffffL); double capture=data.getDouble(16);
        if(data.get(0)!=1||key>1||(data.getShort(2)&65535)!=codec||(data.getInt(8)&0xffffffffL)!=geometryRevision||(data.getInt(12)&0xffffffffL)!=streamGeneration||data.getInt(28)!=length-32||!Double.isFinite(capture)||capture<0||capture>9007199254740991d||capture!=Math.floor(capture)||(data.getShort(24)&65535)!=width||(data.getShort(26)&65535)!=height||frame<=lastFrame||lastFrame==0&&key!=1) throw invalid();
        int current=0; for(Delivery value:deliveries.values()) if(value.bytes!=null&&value.generation==streamGeneration) current++;
        if(current>=BINARY_WINDOW||binaryCount>=BINARY_RETAINED) { close("screen_viewer_congested"); return; }
        byte[] bytes=new byte[length]; data.get(bytes); lastFrame=frame;
        long receipt=++sequence; deliveries.put(receipt,new Delivery(bytes,length,streamGeneration)); binaryCount++;
        emit(new JSONObject().put("kind","binary").put("deliverySequence",receipt).put("byteLength",length));
    }
    byte[] read(long receipt,int offset,int maxBytes) throws Exception { synchronized(owner) {
        requireLive(); Delivery value=deliveries.get(receipt);
        if(value==null||value.bytes==null||offset!=value.offset||offset>=value.size||maxBytes<1||maxBytes>READ_LIMIT) throw new IOException("invalid_screen_read");
        int end=Math.min(value.size,offset+maxBytes); byte[] bytes=Arrays.copyOfRange(value.bytes,offset,end); value.offset=end; return bytes;
    } }
    void ack(long receipt) throws Exception { synchronized(owner) {
        requireLive(); Delivery value=deliveries.get(receipt);
        if(value==null||value.bytes!=null&&value.offset!=value.size) throw new IOException("invalid_screen_receipt");
        deliveries.remove(receipt); if(value.bytes!=null) binaryCount--; else { jsonCount--; jsonBytes-=value.size; }
    } }
    void send(JSONObject command) throws Exception { synchronized(owner) {
        requireLive(); String type=text(command,"type");
        if(!sessionId.equals(text(command,"sessionId"))||!generation.equals(text(command,"generation"))) throw invalid();
        if(type.equals("input-focus")) { keys(command,"type sessionId generation enabled",""); inputFocused=bool(command,"enabled")&&visible&&canControl; return; }
        if(type.equals("visibility")) { keys(command,"type sessionId generation visible",""); visible=bool(command,"visible"); if(!visible) { close("screen_inactive"); return; } }
        else if(type.equals("control")) { keys(command,"type sessionId generation frameSequence",""); integer(command,"frameSequence",1,0xffffffffL); if(!controlAllowed||!visible) throw invalid(); }
        else if(type.equals("renew")) { keys(command,"type sessionId generation leaseId frameSequence challenge",""); token(command,"leaseId"); token(command,"challenge"); integer(command,"frameSequence",1,0xffffffffL); if(!canControl||!inputFocused||!visible) throw controlEnded(); }
        else if(type.equals("input")) { validateInput(command); if(!canControl||!inputFocused||!visible) throw controlEnded(); }
        // heldMs: how long the page held the frame, from a viewer that named its capacity.
        else if(type.equals("ack")) { keys(command,"type sessionId generation frameSequence","heldMs"); integer(command,"frameSequence",1,0xffffffffL); if(command.has("heldMs")) integer(command,"heldMs",0,2000); }
        else if(Arrays.asList("release","disconnect","keyframe").contains(type)) { keys(command,"type sessionId generation",""); if(!type.equals("keyframe")) { inputFocused=false; canControl=false; } }
        else throw invalid();
        String encoded=command.toString(); int size=encoded.getBytes(StandardCharsets.UTF_8).length;
        if(size>CONTROL_LIMIT) throw invalid();
        if(!controlReady) { if(outgoing.size()>=PENDING||outgoingBytes+size>CONTROL_LIMIT) { close("screen_control_backpressure"); throw new IOException("screen_control_backpressure"); } outgoing.add(encoded); outgoingBytes+=size; }
        else if(!control.sendText(encoded)) { close("screen_control_closed"); throw new IOException("screen_control_closed"); }
    } }
    private void validateInput(JSONObject command) throws Exception {
        keys(command,"type sessionId desktopId generation displayId displayRevision leaseId sequence frameSequence expiresAt event","");
        if(!desktopId.equals(text(command,"desktopId"))||!displayId.equals(text(command,"displayId"))||integer(command,"displayRevision",1,0xffffffffL)!=displayRevision) throw invalid();
        token(command,"leaseId"); integer(command,"sequence",1,0xffffffffL); integer(command,"frameSequence",1,0xffffffffL); integer(command,"expiresAt",0,9007199254740991L);
        JSONObject event=object(command,"event"); String kind=text(event,"kind");
        if(Arrays.asList("move","button","wheel").contains(kind)) {
            keys(event,kind.equals("move")?"kind x y":kind.equals("button")?"kind x y button down clicks":"kind x y dx dy",""); number(event,"x",0,1); number(event,"y",0,1);
            if(kind.equals("button")) { integer(event,"button",0,2); bool(event,"down"); integer(event,"clicks",1,3); }
            if(kind.equals("wheel")) { number(event,"dx",-2000,2000); number(event,"dy",-2000,2000); }
        } else if(kind.equals("key")) { keys(event,"kind code down",""); if(!text(event,"code").matches("[A-Za-z0-9]{1,32}")) throw invalid(); bool(event,"down"); }
        else if(kind.equals("text")) { keys(event,"kind text",""); String value=text(event,"text"); if(value.isEmpty()||value.length()>2048||value.matches("(?s).*[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f].*")) throw invalid(); for(int i=0;i<value.length();i++) { char c=value.charAt(i); if(Character.isHighSurrogate(c)) { if(++i>=value.length()||!Character.isLowSurrogate(value.charAt(i))) throw invalid(); } else if(Character.isLowSurrogate(c)) throw invalid(); } }
        else throw invalid();
    }
    private void emit(JSONObject value) throws Exception { if(!closed) events.send(value.put("id",id).put("document",document)); }
    void close(String reason) { synchronized(owner) {
        if(closed) return; closed=true;
        if(attachmentDeadline!=null) attachmentDeadline.cancel(false); if(watchdog!=null) watchdog.cancel(false);
        controlTicket=mediaTicket=null; outgoing.clear(); deliveries.clear(); early.clear(); earlySizes.clear(); earlyBytes=0; jsonBytes=jsonCount=binaryCount=outgoingBytes=0; inputFocused=canControl=false;
        if(control!=null) control.cancel(); if(media!=null) media.cancel();
        try { events.send(new JSONObject().put("id",id).put("document",document).put("kind","close").put("reason",reason)); } catch(Exception ignored) { }
        events.closed();
    } }
}
