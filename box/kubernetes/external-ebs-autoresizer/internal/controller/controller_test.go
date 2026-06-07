package controller

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestRunReconcilesImmediatelyThenStops(t *testing.T) {
	var calls atomic.Int32
	ctx, cancel := context.WithCancel(context.Background())

	go func() {
		// Allow the immediate pass plus a couple of ticks, then cancel.
		time.Sleep(120 * time.Millisecond)
		cancel()
	}()

	Run(ctx, 40*time.Millisecond, func(context.Context) (int, error) {
		calls.Add(1)
		return 0, nil
	}, discardLogger())

	// Immediate pass (1) plus at least one tick.
	if got := calls.Load(); got < 2 {
		t.Errorf("reconcile called %d times, want >= 2", got)
	}
}

func TestRunContinuesAfterError(t *testing.T) {
	var calls atomic.Int32
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(120 * time.Millisecond)
		cancel()
	}()

	Run(ctx, 40*time.Millisecond, func(context.Context) (int, error) {
		calls.Add(1)
		return 0, errors.New("transient")
	}, discardLogger())

	if got := calls.Load(); got < 2 {
		t.Errorf("reconcile called %d times despite errors, want >= 2", got)
	}
}

func TestRunStopsOnCancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already cancelled

	var calls atomic.Int32
	done := make(chan struct{})
	go func() {
		Run(ctx, time.Hour, func(context.Context) (int, error) {
			calls.Add(1)
			return 0, nil
		}, discardLogger())
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Run did not return on cancelled context")
	}
	// Immediate pass runs once before the loop observes cancellation.
	if got := calls.Load(); got != 1 {
		t.Errorf("reconcile called %d times, want 1", got)
	}
}
