package com.tarobot.client;

import static org.junit.Assert.*;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.net.ConnectException;
import java.net.NoRouteToHostException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.security.cert.CertificateException;
import javax.net.ssl.SSLHandshakeException;
import javax.net.ssl.SSLPeerUnverifiedException;
import org.junit.Test;

public class HubTlsErrorClassificationTest {
    @Test public void inspectsOkHttpConnectCauseForConnectionRefusedWithoutLeakingIp() {
        ConnectException outer = new ConnectException("Failed to connect to /100.64.0.1:8788");
        outer.initCause(new ConnectException("failed to connect to /100.64.0.1 (port 8788): connect failed: ECONNREFUSED (Connection refused)"));
        assertEquals("native_connection_refused", HubTls.classifyError(outer));
    }

    @Test public void classifiesAndroidSslHandshakeWithoutSubstringMatch() {
        assertEquals("native_tls_untrusted", HubTls.classifyError(
            new SSLHandshakeException("java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.")));
        assertEquals("native_tls_untrusted", HubTls.classifyError(new SSLHandshakeException("Chain validation failed")));
        assertEquals("native_tls_untrusted", HubTls.classifyError(new SSLPeerUnverifiedException("Hostname 192.168.1.100 not verified")));
    }

    @Test public void preservesPinMismatchOverGenericTlsUntrusted() {
        SSLHandshakeException handshake = new SSLHandshakeException("Chain validation failed");
        handshake.initCause(new CertificateException("tls_identity_mismatch"));
        assertEquals("tls_identity_mismatch", HubTls.classifyError(handshake));
        assertEquals("tls_identity_mismatch", HubTls.classifyError(new IOException("tls_identity_mismatch", handshake)));
    }

    @Test public void classifiesDnsTimeoutsUnreachableResetAndPreservedHubCodes() {
        assertEquals("native_dns_failed", HubTls.classifyError(new UnknownHostException("Unable to resolve host \"macmini.invalid\"")));
        assertEquals("native_request_timeout", HubTls.classifyError(new SocketTimeoutException("connect timed out")));
        assertEquals("native_request_timeout", HubTls.classifyError(new InterruptedIOException("timeout")));
        assertEquals("native_host_unreachable", HubTls.classifyError(new NoRouteToHostException("No route to host")));
        ConnectException unreachable = new ConnectException("Failed to connect to /192.168.1.100:8788");
        unreachable.initCause(new IOException("connect failed: EHOSTUNREACH (No route to host)"));
        assertEquals("native_host_unreachable", HubTls.classifyError(unreachable));
        assertEquals("native_connection_reset", HubTls.classifyError(new IOException("unexpected end of stream on https://192.168.1.100:8788/api/x")));
        assertEquals("native_document_retired", HubTls.classifyError(new IOException("native_document_retired")));
        assertEquals("native_transport_failed", HubTls.classifyError(new IOException("Failed to connect to /192.168.1.100:8788")));
        assertEquals("native_socket_failed", HubTls.classifyError(new RuntimeException("unexpected"), "native_socket_failed"));
    }
}
