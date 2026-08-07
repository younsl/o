package window

import (
	"strings"
	"testing"
	"time"
)

func mustNew(t *testing.T, cfg Config) *Window {
	t.Helper()
	w, err := New(cfg)
	if err != nil {
		t.Fatalf("New(%+v) returned error: %v", cfg, err)
	}
	return w
}

func at(t *testing.T, loc *time.Location, value string) time.Time {
	t.Helper()
	parsed, err := time.ParseInLocation("2006-01-02 15:04", value, loc)
	if err != nil {
		t.Fatalf("parse %q: %v", value, err)
	}
	return parsed
}

// dailyAtTwo opens for three hours every day at 02:00, with 45m required to start.
func dailyAtTwo(t *testing.T) *Window {
	return mustNew(t, Config{
		Timezone:     "Asia/Seoul",
		CronSchedule: "0 2 * * *",
		Duration:     3 * time.Hour,
		MinRemaining: 45 * time.Minute,
	})
}

func TestOpenWithinTheWindow(t *testing.T) {
	w := dailyAtTwo(t)
	loc := w.Location()

	tests := []struct {
		name     string
		when     string
		wantOpen bool
	}{
		{"before the schedule fires", "2026-07-21 01:59", false},
		{"at the firing", "2026-07-21 02:00", true},
		{"mid window", "2026-07-21 03:30", true},
		{"exactly minRemaining left", "2026-07-21 04:15", true},
		{"too little left to verify", "2026-07-21 04:30", false},
		{"after the window closed", "2026-07-21 05:00", false},
		{"next day, window open again", "2026-07-22 02:30", true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			open, detail := w.Open(at(t, loc, tc.when))
			if open != tc.wantOpen {
				t.Fatalf("Open(%s) = %t (%s), want %t", tc.when, open, detail, tc.wantOpen)
			}
			if !open && detail == "" {
				t.Fatal("a closed window must explain why")
			}
		})
	}
}

// A window whose duration runs past midnight must stay open across the date change.
func TestOpenAcrossMidnight(t *testing.T) {
	w := mustNew(t, Config{
		Timezone:     "UTC",
		CronSchedule: "0 23 * * *",
		Duration:     5 * time.Hour,
		MinRemaining: 30 * time.Minute,
	})
	loc := w.Location()

	if open, detail := w.Open(at(t, loc, "2026-07-21 23:30")); !open {
		t.Fatalf("before midnight should be open: %s", detail)
	}
	if open, detail := w.Open(at(t, loc, "2026-07-22 01:00")); !open {
		t.Fatalf("after midnight should still be open: %s", detail)
	}
	if open, _ := w.Open(at(t, loc, "2026-07-22 03:45")); open {
		t.Fatal("less than minRemaining before the 04:00 close should be closed")
	}
	if open, _ := w.Open(at(t, loc, "2026-07-22 12:00")); open {
		t.Fatal("midday is outside the window")
	}
}

// The cron day-of-week field is what restricts weekdays now.
func TestCronDayOfWeekRestrictsDays(t *testing.T) {
	w := mustNew(t, Config{
		Timezone:     "UTC",
		CronSchedule: "0 2 * * 2,4",
		Duration:     3 * time.Hour,
	})
	loc := w.Location()

	monday := at(t, loc, "2026-07-20 03:00")
	if monday.Weekday() != time.Monday {
		t.Fatalf("fixture drift: %s is %s", monday, monday.Weekday())
	}
	if open, _ := w.Open(monday); open {
		t.Fatal("Monday is not in the schedule")
	}
	if open, detail := w.Open(at(t, loc, "2026-07-21 03:00")); !open { // Tuesday
		t.Fatalf("Tuesday is in the schedule: %s", detail)
	}
	if open, detail := w.Open(at(t, loc, "2026-07-23 03:00")); !open { // Thursday
		t.Fatalf("Thursday is in the schedule: %s", detail)
	}
}

// A window opened by a Tuesday firing stays open into Wednesday, even though the
// schedule itself never fires on Wednesday.
func TestWindowOutlivesItsFiringDay(t *testing.T) {
	w := mustNew(t, Config{
		Timezone:     "UTC",
		CronSchedule: "0 23 * * 2",
		Duration:     5 * time.Hour,
	})
	loc := w.Location()

	if open, detail := w.Open(at(t, loc, "2026-07-22 01:00")); !open { // Wednesday
		t.Fatalf("Wednesday 01:00 belongs to Tuesday's window: %s", detail)
	}
	if open, _ := w.Open(at(t, loc, "2026-07-22 23:30")); open {
		t.Fatal("the schedule does not fire on Wednesday")
	}
}

// With several firings inside one duration, the most recent one governs, which is
// what keeps Remaining from reporting a window that already closed.
func TestMostRecentFiringGoverns(t *testing.T) {
	w := mustNew(t, Config{
		Timezone:     "UTC",
		CronSchedule: "0 * * * *", // hourly
		Duration:     3 * time.Hour,
	})
	loc := w.Location()

	// 03:00 is the latest firing at or before 03:30, so 2h30m is left.
	if got, want := w.Remaining(at(t, loc, "2026-07-21 03:30")), 2*time.Hour+30*time.Minute; got != want {
		t.Fatalf("Remaining = %s, want %s", got, want)
	}
}

func TestRemainingIsZeroWhenClosed(t *testing.T) {
	w := dailyAtTwo(t)
	loc := w.Location()

	if got, want := w.Remaining(at(t, loc, "2026-07-21 04:00")), time.Hour; got != want {
		t.Fatalf("Remaining = %s, want %s", got, want)
	}
	if got := w.Remaining(at(t, loc, "2026-07-21 06:00")); got != 0 {
		t.Fatalf("Remaining outside the window = %s, want 0", got)
	}
}

func TestStartBudgetRunsOutBeforeTheWindowCloses(t *testing.T) {
	w := dailyAtTwo(t)
	loc := w.Location()

	tests := []struct {
		name string
		when string
		want time.Duration
	}{
		{"at the firing", "2026-07-21 02:00", 2*time.Hour + 15*time.Minute},
		{"mid window", "2026-07-21 03:30", 45 * time.Minute},
		{"exactly minRemaining left", "2026-07-21 04:15", 0},
		{"too little left to start", "2026-07-21 04:30", 0},
		{"after the window closed", "2026-07-21 06:00", 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := w.StartBudget(at(t, loc, tc.when)); got != tc.want {
				t.Fatalf("StartBudget(%s) = %s, want %s", tc.when, got, tc.want)
			}
		})
	}
}

// TestStartBudgetAgreesWithOpen walks a whole day a minute at a time. Any budget left
// must mean Open agrees a replacement may start, so a caller can wait on the budget
// alone instead of having to consult both.
func TestStartBudgetAgreesWithOpen(t *testing.T) {
	w := dailyAtTwo(t)
	loc := w.Location()

	start := at(t, loc, "2026-07-21 00:00")
	positive := 0
	for i := range 24 * 60 {
		when := start.Add(time.Duration(i) * time.Minute)
		open, _ := w.Open(when)
		budget := w.StartBudget(when)
		if budget < 0 {
			t.Fatalf("StartBudget(%s) = %s, want no negative budget", when, budget)
		}
		if budget > 0 {
			positive++
			if !open {
				t.Fatalf("StartBudget(%s) = %s but Open reports closed", when, budget)
			}
		}
	}
	// 02:00 through 04:14 inclusive, the minutes with a start still ahead of them.
	if want := 135; positive != want {
		t.Fatalf("minutes with budget left = %d, want %d", positive, want)
	}
}

func TestNextOpen(t *testing.T) {
	w := dailyAtTwo(t)
	loc := w.Location()

	got := w.NextOpen(at(t, loc, "2026-07-21 06:00"))
	want := at(t, loc, "2026-07-22 02:00")
	if !got.Equal(want) {
		t.Fatalf("NextOpen = %s, want %s", got, want)
	}
}

// A closed window names the next opening, so operators do not have to decode the
// cron expression themselves.
func TestClosedWindowReportsTheNextOpening(t *testing.T) {
	w := dailyAtTwo(t)
	loc := w.Location()

	_, detail := w.Open(at(t, loc, "2026-07-21 06:00"))
	if !strings.Contains(detail, "next opens at") {
		t.Fatalf("detail = %q, want it to name the next opening", detail)
	}
	if !strings.Contains(detail, "2026-07-22 02:00") {
		t.Fatalf("detail = %q, want the next opening time", detail)
	}
}

func TestNewRejectsBadInput(t *testing.T) {
	tests := []struct {
		name string
		cfg  Config
	}{
		{"unknown timezone", Config{Timezone: "Mars/Olympus", CronSchedule: "0 2 * * *", Duration: time.Hour}},
		{"empty schedule", Config{Timezone: "UTC", Duration: time.Hour}},
		{"malformed schedule", Config{Timezone: "UTC", CronSchedule: "0 2 * *", Duration: time.Hour}},
		{"out-of-range field", Config{Timezone: "UTC", CronSchedule: "0 99 * * *", Duration: time.Hour}},
		{"zero duration", Config{Timezone: "UTC", CronSchedule: "0 2 * * *"}},
		{"negative duration", Config{Timezone: "UTC", CronSchedule: "0 2 * * *", Duration: -time.Hour}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := New(tc.cfg); err == nil {
				t.Fatalf("New(%+v) should have failed", tc.cfg)
			}
		})
	}
}

// Cron descriptors are accepted, so an operator can write @daily instead of 0 0 * * *.
func TestNewAcceptsCronDescriptors(t *testing.T) {
	for _, spec := range []string{"@daily", "@weekly", "@every 6h"} {
		if _, err := New(Config{Timezone: "UTC", CronSchedule: spec, Duration: time.Hour}); err != nil {
			t.Fatalf("New with schedule %q returned error: %v", spec, err)
		}
	}
}

func TestStringDescribesTheWindow(t *testing.T) {
	w := dailyAtTwo(t)
	got := w.String()
	for _, want := range []string{"0 2 * * *", "3h", "Asia/Seoul", "45m"} {
		if !strings.Contains(got, want) {
			t.Fatalf("String() = %q, expected it to mention %q", got, want)
		}
	}
	if w.Duration() != 3*time.Hour {
		t.Fatalf("Duration() = %s, want 3h", w.Duration())
	}
}
