package repo

import (
	"errors"
	"net"
	"net/http"
	"net/netip"
	"syscall"
	"time"
)

// newPublicOnlyClient builds an HTTP client whose dialer refuses loopback,
// private, link-local and other non-global destination addresses. The check
// runs after DNS resolution on every connection attempt, so it also covers
// redirects and DNS-rebinding. Used for URLs that originate from clients
// (e.g. the PyPI base64url file refs) rather than from admin configuration.
func newPublicOnlyClient(timeout time.Duration) *http.Client {
	dialer := &net.Dialer{Timeout: 10 * time.Second, Control: publicOnlyDialControl}
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			Proxy:       http.ProxyFromEnvironment,
			DialContext: dialer.DialContext,
		},
	}
}

func publicOnlyDialControl(_, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return errors.New("refusing dial to unparseable address")
	}
	ip = ip.Unmap()
	if !ip.IsValid() || ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() {
		return errors.New("refusing dial to non-public address")
	}
	return nil
}
