// Command argocd-promotion-gate blocks an Argo CD Application sync until the
// same application has been promoted in the upstream environment.
//
// It runs two listeners: an HTTPS ValidatingAdmissionWebhook that enforces the
// gate, and a plain HTTP listener serving probes, metrics, and the read-only
// API behind the Argo CD UI extension.
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"

	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/admission"
	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/argocd"
	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/config"
	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/engine"
	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/extension"
	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/gate"
	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/observability"
	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/uiextension"
	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/version"
)

// installExtensionCmd writes the embedded UI extension script into an Argo CD
// extensions directory and exits.
const installExtensionCmd = "install-extension"

// buildTime is the fixed modification time stamped into the extension archive.
// A real clock reading would change the bytes on every request and defeat any
// caching or checksum the installer applies.
var buildTime = time.Unix(0, 0).UTC()

// shutdownTimeout bounds in-flight requests during a graceful stop. It stays
// under the usual pod terminationGracePeriodSeconds so the process exits on
// its own terms rather than being killed.
const shutdownTimeout = 10 * time.Second

// exemptScanTimeout bounds the one-off startup listing. It is a report, not a
// dependency, so it gives up quickly.
const exemptScanTimeout = 10 * time.Second

// maxExemptNamesLogged caps the names printed for the startup scan.
const maxExemptNamesLogged = 20

type flags struct {
	configPath    string
	webhookAddr   string
	adminAddr     string
	tlsCertFile   string
	tlsKeyFile    string
	kubeconfig    string
	logLevel      string
	logFormat     string
	extensionName string
	showVersion   bool
}

// installExtension writes the embedded script where argocd-server will find it.
func installExtension(args []string) error {
	fs := flag.NewFlagSet(installExtensionCmd, flag.ExitOnError)
	root := fs.String("dest", "/tmp/extensions", "Argo CD extensions directory to write into")
	name := fs.String("extension-name", uiextension.DefaultName, "name argocd-server proxies the gate API under")
	if err := fs.Parse(args); err != nil {
		return err
	}
	path, err := uiextension.Install(*root, *name)
	if err != nil {
		return err
	}
	fmt.Printf("wrote %s for extension name %s\n", path, *name)
	return nil
}

func main() {
	// One subcommand, handled before flag parsing so it can own its own flags.
	// It exists because argocd-server loads extension scripts from its own
	// filesystem, so an init container has to place the embedded script there.
	if len(os.Args) > 1 && os.Args[1] == installExtensionCmd {
		if err := installExtension(os.Args[2:]); err != nil {
			fmt.Fprintf(os.Stderr, "install-extension: %v\n", err)
			os.Exit(1)
		}
		return
	}

	f := parseFlags()

	if f.showVersion {
		fmt.Printf("argocd-promotion-gate %s\ncommit: %s\ngo: %s\nplatform: %s/%s\n",
			version.Version, version.Commit, runtime.Version(), runtime.GOOS, runtime.GOARCH)
		return
	}

	logger := newLogger(f.logLevel, f.logFormat)
	if err := run(f, logger); err != nil {
		logger.Error("fatal", "error", err)
		os.Exit(1)
	}
}

func parseFlags() flags {
	var f flags
	flag.StringVar(&f.configPath, "config", envOr("GATE_CONFIG", "/etc/argocd-promotion-gate/config.yaml"), "path to the gate configuration file")
	flag.StringVar(&f.webhookAddr, "webhook-addr", envOr("WEBHOOK_ADDR", ":8443"), "address for the HTTPS admission webhook listener")
	flag.StringVar(&f.adminAddr, "admin-addr", envOr("ADMIN_ADDR", ":8080"), "address for probes, metrics, and the UI extension API")
	flag.StringVar(&f.tlsCertFile, "tls-cert-file", envOr("TLS_CERT_FILE", "/etc/argocd-promotion-gate/tls/tls.crt"), "PEM serving certificate for the webhook listener")
	flag.StringVar(&f.tlsKeyFile, "tls-key-file", envOr("TLS_KEY_FILE", "/etc/argocd-promotion-gate/tls/tls.key"), "PEM private key for the webhook listener")
	flag.StringVar(&f.kubeconfig, "kubeconfig", os.Getenv("KUBECONFIG"), "path to a kubeconfig; empty uses the in-cluster config")
	flag.StringVar(&f.logLevel, "log-level", envOr("LOG_LEVEL", "info"), "log level: debug, info, warn, error")
	flag.StringVar(&f.logFormat, "log-format", envOr("LOG_FORMAT", "json"), "log format: json or text")
	flag.StringVar(&f.extensionName, "extension-name", envOr("EXTENSION_NAME", uiextension.DefaultName), "name argocd-server proxies the gate API under; must match argocd-cm")
	flag.BoolVar(&f.showVersion, "version", false, "print version and exit")
	flag.Parse()
	return f
}

func run(f flags, logger *slog.Logger) error {
	ctx0 := context.Background()

	// Printed before anything can fail, so a bug report always carries the
	// build and the runtime it came from.
	logger.Info("starting argocd-promotion-gate",
		"version", version.Version,
		"commit", version.Commit,
		"go", runtime.Version(),
		"platform", runtime.GOOS+"/"+runtime.GOARCH,
		"cpus", runtime.NumCPU(),
		"config", f.configPath,
		"webhookAddr", f.webhookAddr,
		"adminAddr", f.adminAddr,
	)

	cfg, err := config.Load(f.configPath)
	if err != nil {
		return err
	}
	logGateConfig(logger, cfg)

	restCfg, err := restConfig(f.kubeconfig)
	if err != nil {
		return err
	}
	dyn, err := dynamic.NewForConfig(restCfg)
	if err != nil {
		return fmt.Errorf("build dynamic kubernetes client: %w", err)
	}

	metrics := observability.NewMetrics()
	reader := argocd.NewReader(dyn, cfg.ArgoCD.Namespace, cfg.Exempt.Annotation)

	var images engine.ImageResolver
	if cfg.ImageTag.Enabled {
		client, err := argocd.NewDesiredImageClient(cfg.ArgoCD, cfg.ImageTag.Kinds)
		if err != nil {
			return fmt.Errorf("build argocd api client: %w", err)
		}
		if !client.HasToken() {
			logger.Warn("no argocd api token found; desired image lookups will fail until the secret is mounted",
				"tokenPath", cfg.ArgoCD.TokenPath, "onError", string(cfg.ImageTag.OnError))
		}
		images = client
	} else {
		logger.Info("image tag comparison disabled; only upstream sync and health are checked")
	}

	logExemptApplications(ctx0, logger, cfg, reader)

	eng := engine.New(cfg, reader, images, metrics, logger)
	ext := extension.NewHandler(eng, logger)

	adminMux := http.NewServeMux()
	adminMux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	adminMux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	adminMux.Handle("GET /metrics", promhttp.HandlerFor(metrics.Registry(), promhttp.HandlerOpts{}))
	adminMux.HandleFunc("GET /api/v1/gate", ext.Gate)
	adminMux.HandleFunc("GET /api/v1/config", ext.Config)
	// Serving the script here is not how the browser gets it, since Argo CD
	// loads extensions off disk. It is here so the running version can be
	// diffed against what argocd-server is actually serving.
	// The upstream delivery path: argocd-extension-installer fetches this with
	// its standard EXTENSION_URL and unpacks it into argocd-server's extensions
	// volume, so the wiring stays conventional while the script and the API it
	// calls still ship as one artifact.
	adminMux.HandleFunc("GET /api/v1/extension.tar", func(w http.ResponseWriter, _ *http.Request) {
		archive, err := uiextension.Tar(f.extensionName, buildTime)
		if err != nil {
			logger.Error("could not pack the embedded extension script", "error", err)
			http.Error(w, "extension archive unavailable", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/x-tar")
		if _, err := w.Write(archive); err != nil {
			logger.Warn("could not write the extension archive", "error", err)
		}
	})
	adminMux.HandleFunc("GET /api/v1/extension.js", func(w http.ResponseWriter, _ *http.Request) {
		script, err := uiextension.Script(f.extensionName)
		if err != nil {
			logger.Error("could not render the embedded extension script", "error", err)
			http.Error(w, "extension script unavailable", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		if _, err := w.Write(script); err != nil {
			logger.Warn("could not write the extension script", "error", err)
		}
	})

	webhookMux := http.NewServeMux()
	webhookMux.Handle("POST /validate", admission.NewHandler(eng, metrics, logger))

	adminSrv := &http.Server{
		Addr:              f.adminAddr,
		Handler:           adminMux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	webhookSrv := &http.Server{
		Addr:              f.webhookAddr,
		Handler:           webhookMux,
		ReadHeaderTimeout: 5 * time.Second,
		TLSConfig:         &tls.Config{MinVersion: tls.VersionTLS12},
	}

	ctx, stop := signal.NotifyContext(ctx0, syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 2)
	go func() {
		logger.Info("admin and extension API listening", "addr", f.adminAddr)
		if err := adminSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- fmt.Errorf("admin server: %w", err)
		}
	}()
	go func() {
		logger.Info("admission webhook listening", "addr", f.webhookAddr)
		if err := webhookSrv.ListenAndServeTLS(f.tlsCertFile, f.tlsKeyFile); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- fmt.Errorf("webhook server: %w", err)
		}
	}()

	select {
	case err := <-errCh:
		shutdown(adminSrv, webhookSrv, logger)
		return err
	case <-ctx.Done():
		logger.Info("shutdown signal received")
		shutdown(adminSrv, webhookSrv, logger)
		return nil
	}
}

func shutdown(admin, webhook *http.Server, logger *slog.Logger) {
	ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	for name, srv := range map[string]*http.Server{"admin": admin, "webhook": webhook} {
		if err := srv.Shutdown(ctx); err != nil {
			logger.Warn("graceful shutdown failed", "server", name, "error", err)
		}
	}
}

// logGateConfig prints the whole effective policy at startup.
//
// Every value here is either a decision somebody made or a default they
// inherited, and a gate that refuses a deploy is the wrong place to be guessing
// which. The resolved chain is included because an off-by-one in the order is
// the mistake that would be hardest to spot from the raw list alone.
func logGateConfig(logger *slog.Logger, cfg config.Config) {
	logger.Info("gate policy",
		"chain", cfg.Chain,
		"gatedEnvs", gatedEnvs(cfg),
		"gatedEnvsExplicit", len(cfg.GatedEnvs) > 0,
		"requireSync", cfg.Require.Sync,
		"requireHealth", cfg.Require.Health,
		"rollbackAllowed", cfg.Rollback.AllowPreviouslyDeployedRevision,
	)

	for _, env := range gatedEnvs(cfg) {
		upstream, _ := cfg.UpstreamEnv(env)
		logger.Info("chain resolved", "env", env, "upstream", upstream)
	}

	if cfg.ImageTag.Enabled {
		logger.Info("image tag check",
			"mode", string(cfg.ImageTag.Mode),
			"onError", string(cfg.ImageTag.OnError),
			"kinds", cfg.ImageTag.Kinds,
			"ignoreRepos", cfg.ImageTag.IgnoreRepos,
		)
	} else {
		logger.Info("image tag check disabled; only upstream sync and health are checked")
	}

	logger.Info("exemptions",
		"usernames", cfg.Exempt.Usernames,
		"automated", cfg.Exempt.Automated,
		"skipAnnotation", cfg.Exempt.Annotation,
		"skipAnnotationValue", "true",
	)

	logger.Info("argocd access",
		"namespace", cfg.ArgoCD.Namespace,
		"serverAddress", cfg.ArgoCD.ServerAddress,
		"caFile", orNone(cfg.ArgoCD.CAFile),
		"insecureSkipVerify", cfg.ArgoCD.InsecureSkipVerify,
		"tokenPath", cfg.ArgoCD.TokenPath,
		"timeoutSeconds", cfg.ArgoCD.TimeoutSeconds,
		"cacheTtlSeconds", cfg.ArgoCD.CacheTTLSeconds,
	)
}

// exemptNames returns the applications carrying the skip annotation, split by
// whether the gate would otherwise have enforced anything on them.
//
// Both numbers matter. The total says how widely the hatch is open, and the
// gated subset says how much of it is actually bypassing a check rather than
// sitting on an environment the gate ignores anyway.
func exemptNames(cfg config.Config, apps []gate.AppSnapshot) (all, gated []string) {
	for _, app := range apps {
		if !app.SkipRequested {
			continue
		}
		all = append(all, app.Name)
		if cfg.IsGated(app.Project) {
			gated = append(gated, app.Name)
		}
	}
	sort.Strings(all)
	sort.Strings(gated)
	return all, gated
}

// logExemptApplications counts the annotation's current reach at startup.
//
// Read-only and non-fatal: a listing failure is worth a warning but must not
// stop a gate from starting.
func logExemptApplications(ctx context.Context, logger *slog.Logger, cfg config.Config, reader *argocd.Reader) {
	listCtx, cancel := context.WithTimeout(ctx, exemptScanTimeout)
	defer cancel()

	apps, err := reader.List(listCtx)
	if err != nil {
		logger.Warn("could not list applications to report current exemptions",
			"namespace", cfg.ArgoCD.Namespace,
			"annotation", cfg.Exempt.Annotation,
			"error", err)
		return
	}

	all, gated := exemptNames(cfg, apps)
	fields := []any{
		"annotation", cfg.Exempt.Annotation,
		"namespace", cfg.ArgoCD.Namespace,
		"applicationsScanned", len(apps),
		"exempt", len(all),
		"exemptInGatedEnvs", len(gated),
	}
	if len(all) > 0 {
		fields = append(fields, "apps", truncateNames(all))
	}
	logger.Info("skip annotation scan", fields...)
}

// truncateNames keeps a long list from turning one startup line into a wall.
func truncateNames(names []string) []string {
	if len(names) <= maxExemptNamesLogged {
		return names
	}
	out := append([]string(nil), names[:maxExemptNamesLogged]...)
	return append(out, fmt.Sprintf("and %d more", len(names)-maxExemptNamesLogged))
}

// gatedEnvs resolves the environments the gate actually enforces, which with an
// empty list is the whole chain except its head.
func gatedEnvs(cfg config.Config) []string {
	if len(cfg.GatedEnvs) > 0 {
		return cfg.GatedEnvs
	}
	if len(cfg.Chain) < 2 {
		return nil
	}
	return cfg.Chain[1:]
}

func orNone(value string) string {
	if strings.TrimSpace(value) == "" {
		return "<none>"
	}
	return value
}

func restConfig(kubeconfig string) (*rest.Config, error) {
	if kubeconfig != "" {
		cfg, err := clientcmd.BuildConfigFromFlags("", kubeconfig)
		if err != nil {
			return nil, fmt.Errorf("build config from kubeconfig %s: %w", kubeconfig, err)
		}
		return cfg, nil
	}
	cfg, err := rest.InClusterConfig()
	if err != nil {
		return nil, fmt.Errorf("build in-cluster config: %w", err)
	}
	return cfg, nil
}

func newLogger(level, format string) *slog.Logger {
	var lvl slog.Level
	switch strings.ToLower(level) {
	case "debug":
		lvl = slog.LevelDebug
	case "warn":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		lvl = slog.LevelInfo
	}
	opts := &slog.HandlerOptions{Level: lvl}
	var handler slog.Handler
	if strings.EqualFold(format, "text") {
		handler = slog.NewTextHandler(os.Stdout, opts)
	} else {
		handler = slog.NewJSONHandler(os.Stdout, opts)
	}
	return slog.New(handler)
}

func envOr(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}
