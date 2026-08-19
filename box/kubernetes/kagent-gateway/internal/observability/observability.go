// Package observability holds the Prometheus registry, the metric set, and
// the HTTP servers that expose /metrics and the health endpoints.
package observability

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"runtime"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

const namespace = "kagent_gateway"

// Metrics is the gateway metric set, registered on its own registry so the
// exposed series stay limited to what this binary owns.
//
// Every label used here is bounded by configuration or by a fixed set of
// outcomes. Alert identity (alertname, fingerprint, group key) is deliberately
// absent: it belongs in the logs, where it costs one line, not in a time
// series, where it costs one series per alert rule forever.
type Metrics struct {
	registry *prometheus.Registry

	WebhooksReceived  *prometheus.CounterVec
	WebhookDuration   prometheus.Histogram
	AlertsReceived    *prometheus.CounterVec
	SlackMessages     *prometheus.CounterVec
	SlackTruncations  *prometheus.CounterVec
	SlackAPIRequests  *prometheus.CounterVec
	SlackAPIDuration  *prometheus.HistogramVec
	ParentLookups     *prometheus.CounterVec
	ParentLookupTries prometheus.Histogram
	Analyses          *prometheus.CounterVec
	AnalysesSkipped   *prometheus.CounterVec
	AnalysisDuration  prometheus.Histogram
	AnalysisQueueWait prometheus.Histogram
	AnalysesInflight  prometheus.Gauge
	AnalysesQueued    prometheus.Gauge
	AnalysisSlots     prometheus.Gauge
	DedupeEntries     prometheus.Gauge
	AgentRequests     *prometheus.CounterVec
	AgentDuration     *prometheus.HistogramVec
	AgentTaskDuration *prometheus.HistogramVec
	AgentTaskPolls    prometheus.Histogram

	SocketConnected   prometheus.Gauge
	SocketConnections *prometheus.CounterVec
	ChatEvents        *prometheus.CounterVec
	ChatTurns         *prometheus.CounterVec
	ChatTurnDuration  prometheus.Histogram
	ChatInflight      prometheus.Gauge
	ChatSlots         prometheus.Gauge
	ChatSessions      prometheus.Gauge
}

// NewMetrics builds and registers the metric set.
func NewMetrics() *Metrics {
	m := &Metrics{
		registry: prometheus.NewRegistry(),
		WebhooksReceived: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "webhooks_received_total",
			Help:      "Alertmanager webhook requests received, by outcome.",
		}, []string{"result"}),
		WebhookDuration: prometheus.NewHistogram(prometheus.HistogramOpts{
			Namespace: namespace,
			Name:      "webhook_duration_seconds",
			Help:      "Time spent serving one Alertmanager webhook request. The analysis runs detached, so this only covers decoding, filtering, and the parent post in post mode.",
			Buckets:   []float64{0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10},
		}),
		AlertsReceived: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "alerts_received_total",
			Help:      "Individual alerts carried by the received webhooks, by severity and status. One webhook is one alert group and can hold many alerts.",
		}, []string{"severity", "status"}),
		SlackMessages: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "slack_messages_total",
			Help:      "Slack chat.postMessage calls, by message kind and outcome.",
		}, []string{"kind", "result"}),
		SlackTruncations: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "slack_messages_truncated_total",
			Help:      "Messages cut to SLACK_MAX_TEXT before posting, by message kind. A thread truncation means part of the analysis never reached the reader.",
		}, []string{"kind"}),
		SlackAPIRequests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "slack_api_requests_total",
			Help:      "Slack Web API HTTP attempts, by method and outcome. Counts every attempt, so retries are visible against slack_messages_total.",
		}, []string{"method", "result"}),
		SlackAPIDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Namespace: namespace,
			Name:      "slack_api_request_duration_seconds",
			Help:      "Latency of one Slack Web API attempt, by method.",
			Buckets:   []float64{0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30},
		}, []string{"method"}),
		ParentLookups: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "parent_lookups_total",
			Help:      "Searches for the Alertmanager notification to thread under, by outcome. Only used in lookup parent mode.",
		}, []string{"result"}),
		ParentLookupTries: prometheus.NewHistogram(prometheus.HistogramOpts{
			Namespace: namespace,
			Name:      "parent_lookup_attempts",
			Help:      "History scans spent on one parent lookup. Rising counts mean the Alertmanager notification keeps arriving after the webhook.",
			Buckets:   []float64{1, 2, 3, 5, 10},
		}),
		Analyses: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "analyses_total",
			Help:      "Agent analysis runs, by the agent that handled the alert and the outcome.",
		}, []string{"agent", "result"}),
		AnalysesSkipped: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "analyses_skipped_total",
			Help:      "Alert groups that were posted but not analysed, by reason.",
		}, []string{"reason"}),
		AnalysisDuration: prometheus.NewHistogram(prometheus.HistogramOpts{
			Namespace: namespace,
			Name:      "analysis_duration_seconds",
			Help:      "Wall-clock duration of one polled agent analysis run, measured by the gateway around the whole A2A exchange.",
			Buckets:   []float64{1, 5, 10, 20, 30, 60, 90, 120, 180, 300},
		}),
		AnalysisQueueWait: prometheus.NewHistogram(prometheus.HistogramOpts{
			Namespace: namespace,
			Name:      "analysis_queue_wait_seconds",
			Help:      "Time an accepted alert group waited for a free analysis slot before its agent run started.",
			Buckets:   []float64{0.001, 0.1, 1, 5, 15, 30, 60, 120, 300},
		}),
		AnalysesInflight: prometheus.NewGauge(prometheus.GaugeOpts{
			Namespace: namespace,
			Name:      "analyses_inflight",
			Help:      "Agent analysis runs currently executing.",
		}),
		AnalysesQueued: prometheus.NewGauge(prometheus.GaugeOpts{
			Namespace: namespace,
			Name:      "analyses_queued",
			Help:      "Accepted alert groups waiting for a free analysis slot.",
		}),
		AnalysisSlots: prometheus.NewGauge(prometheus.GaugeOpts{
			Namespace: namespace,
			Name:      "analysis_slots",
			Help:      "Configured MAX_CONCURRENT_ANALYSES, so saturation can be read as a ratio without hardcoding the limit in a query.",
		}),
		DedupeEntries: prometheus.NewGauge(prometheus.GaugeOpts{
			Namespace: namespace,
			Name:      "dedupe_entries",
			Help:      "Alert groups currently held in the in-memory dedupe store.",
		}),
		AgentRequests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "agent_requests_total",
			Help:      "A2A JSON-RPC calls to the kagent controller, by method (message/send, tasks/get, tasks/cancel) and outcome.",
		}, []string{"method", "result"}),
		AgentDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Namespace: namespace,
			Name:      "agent_request_duration_seconds",
			Help:      "Latency of one A2A JSON-RPC call, by method. Bounded by KAGENT_REQUEST_TIMEOUT, and unrelated to how long the analysis itself takes.",
			Buckets:   []float64{0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30},
		}, []string{"method"}),
		AgentTaskDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Namespace: namespace,
			Name:      "agent_task_duration_seconds",
			Help:      "Time the kagent controller took to drive one task to a terminal state, from the accepted submission to the poll that observed the state, by agent and by that state. The gateway adds two states of its own: timeout when the analysis deadline hit first, and unreachable when polling was abandoned after repeated failures.",
			Buckets:   []float64{1, 5, 10, 20, 30, 60, 90, 120, 180, 300},
		}, []string{"agent", "state"}),
		AgentTaskPolls: prometheus.NewHistogram(prometheus.HistogramOpts{
			Namespace: namespace,
			Name:      "agent_task_polls",
			Help:      "tasks/get reads spent on one task before it reached a terminal state.",
			Buckets:   []float64{1, 2, 4, 8, 16, 32, 64},
		}),
		SocketConnected: prometheus.NewGauge(prometheus.GaugeOpts{
			Namespace: namespace,
			Name:      "socket_connected",
			Help:      "1 while a Socket Mode connection is established. Readiness stays tied to the HTTP listener, so this gauge is what tells a dropped mention path from a healthy pod.",
		}),
		SocketConnections: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "socket_connections_total",
			Help:      "Socket Mode connection attempts, by outcome: ok, error, or disconnect_requested when Slack asked for a reconnect.",
		}, []string{"result"}),
		ChatEvents: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "chat_events_total",
			Help:      "Mention events received over Socket Mode, by outcome: accepted, or the reason the event was dropped.",
		}, []string{"result"}),
		ChatTurns: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "chat_turns_total",
			Help:      "Agent turns answering a mention, by the agent that handled it and the outcome.",
		}, []string{"agent", "result"}),
		ChatTurnDuration: prometheus.NewHistogram(prometheus.HistogramOpts{
			Namespace: namespace,
			Name:      "chat_turn_duration_seconds",
			Help:      "Wall-clock duration of one mention turn, from the accepted event to the posted reply.",
			Buckets:   []float64{1, 5, 10, 20, 30, 60, 90, 120, 180, 300},
		}),
		ChatInflight: prometheus.NewGauge(prometheus.GaugeOpts{
			Namespace: namespace,
			Name:      "chat_inflight",
			Help:      "Mention turns currently executing.",
		}),
		ChatSlots: prometheus.NewGauge(prometheus.GaugeOpts{
			Namespace: namespace,
			Name:      "chat_slots",
			Help:      "Configured MAX_CONCURRENT_CHATS, so saturation can be read as a ratio the same way analysis_slots allows.",
		}),
		ChatSessions: prometheus.NewGauge(prometheus.GaugeOpts{
			Namespace: namespace,
			Name:      "chat_sessions",
			Help:      "Slack threads currently holding an A2A contextId.",
		}),
	}
	m.registry.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		m.WebhooksReceived, m.WebhookDuration, m.AlertsReceived,
		m.SlackMessages, m.SlackTruncations, m.SlackAPIRequests, m.SlackAPIDuration,
		m.ParentLookups, m.ParentLookupTries, m.Analyses, m.AnalysesSkipped,
		m.AnalysisDuration, m.AnalysisQueueWait, m.AnalysesInflight,
		m.AnalysesQueued, m.AnalysisSlots, m.DedupeEntries,
		m.AgentRequests, m.AgentDuration, m.AgentTaskDuration, m.AgentTaskPolls,
		m.SocketConnected, m.SocketConnections, m.ChatEvents, m.ChatTurns,
		m.ChatTurnDuration, m.ChatInflight, m.ChatSlots, m.ChatSessions,
	)
	return m
}

// The recording helpers below are nil-receiver safe. The Slack and A2A clients
// are usable without a metric set, in tests and in any caller that only wants
// the transport, and a nil check here keeps that from leaking into every call
// site as an if statement.

// ObserveSlackRequest records one Slack Web API attempt. result is ok,
// rate_limited, or error.
func (m *Metrics) ObserveSlackRequest(method, result string, d time.Duration) {
	if m == nil {
		return
	}
	m.SlackAPIRequests.WithLabelValues(method, result).Inc()
	m.SlackAPIDuration.WithLabelValues(method).Observe(d.Seconds())
}

// ObserveAgentRequest records one A2A JSON-RPC call. result is ok or error.
func (m *Metrics) ObserveAgentRequest(method, result string, d time.Duration) {
	if m == nil {
		return
	}
	m.AgentRequests.WithLabelValues(method, result).Inc()
	m.AgentDuration.WithLabelValues(method).Observe(d.Seconds())
}

// ObserveAgentTask records how long the controller took to bring one agent's
// task to state, and how many polls that took.
func (m *Metrics) ObserveAgentTask(agent, state string, polls int, d time.Duration) {
	if m == nil {
		return
	}
	m.AgentTaskDuration.WithLabelValues(agent, state).Observe(d.Seconds())
	m.AgentTaskPolls.Observe(float64(polls))
}

// ObserveSocketConnection records one Socket Mode connection attempt and moves
// the connected gauge with it. result is ok, error, or disconnect_requested.
func (m *Metrics) ObserveSocketConnection(result string) {
	if m == nil {
		return
	}
	m.SocketConnections.WithLabelValues(result).Inc()
}

// SetSocketConnected publishes whether a Socket Mode connection is up.
func (m *Metrics) SetSocketConnected(up bool) {
	if m == nil {
		return
	}
	value := 0.0
	if up {
		value = 1
	}
	m.SocketConnected.Set(value)
}

// Registry returns the registry backing the metric set.
func (m *Metrics) Registry() *prometheus.Registry { return m.registry }

// RegisterBuildInfo registers the standard build_info gauge on the registry.
func (m *Metrics) RegisterBuildInfo(version, commit string) {
	buildInfo := prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Namespace: namespace,
		Name:      "build_info",
		Help:      "Build information. Value is always 1; labels carry the version, git commit, and Go runtime version.",
	}, []string{"version", "commit", "go_version"})
	buildInfo.WithLabelValues(version, commit, runtime.Version()).Set(1)
	m.registry.MustRegister(buildInfo)
}

// Health serves /healthz and /readyz. The gateway is ready as soon as its
// dependencies are wired, because it holds no state that needs warming.
type Health struct{}

// Handler returns the health endpoints as a mux, so the caller can mount them
// on the same listener as the webhook.
func (Health) Handler() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	return mux
}

// ServeMetrics runs the /metrics HTTP server until ctx is cancelled. Handler
// and server-internal errors are routed through logger so all output stays
// structured.
func ServeMetrics(ctx context.Context, port int, registry *prometheus.Registry, logger *slog.Logger) error {
	mux := http.NewServeMux()
	mux.Handle("GET /metrics", promhttp.HandlerFor(registry, promhttp.HandlerOpts{
		ErrorLog: slog.NewLogLogger(logger.Handler(), slog.LevelError),
	}))
	return Serve(ctx, port, mux, logger)
}

// Serve runs an HTTP server on port until ctx is cancelled, then drains it.
func Serve(ctx context.Context, port int, handler http.Handler, logger *slog.Logger) error {
	srv := &http.Server{
		Addr:              fmt.Sprintf(":%d", port),
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelError),
	}
	errCh := make(chan error, 1)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()
	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	case err := <-errCh:
		return err
	}
}
