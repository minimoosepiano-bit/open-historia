/*! Open Historia — real-time clock core © 2026 Nicholas Krol, MIT (see src/Editor/LICENSE). */
// Pure scheduling math for real-time mode. The driver that actually runs the
// clock and calls the simulator lives in src/Game/AI/realtimeClock.js; this
// file stays free of browser and AI imports so it can be unit-tested with
// `node --test` (see realtimeCore.test.js), the same split regionSeedCore.js
// uses.
//
// The model, in one paragraph: while the clock runs, wall-clock seconds are
// converted into game days at the current speed and pile up in `pendingDays`.
// Once enough have piled up (`tickDays`), the driver dispatches ONE simulation
// slice covering whole days of that backlog — the same jump the "jump forward"
// panel runs, just small and automatic. Generation takes real time, so days
// keep accruing while a slice is in flight; the cap below is what stops the
// clock from running away from a simulator that can't keep up.

// Seconds of real time per game day, per speed step. Tuned against how long a
// jump generation actually takes (tens of seconds): at every step a tick lands
// roughly every TARGET_TICK_SECONDS, and it is the SPAN each tick covers that
// grows with speed, not the number of AI calls per minute.
export const REALTIME_SPEEDS = [
    { id: 1, label: "1×", name: "Slow", secondsPerDay: 12 },
    { id: 2, label: "2×", name: "Normal", secondsPerDay: 4 },
    { id: 3, label: "3×", name: "Fast", secondsPerDay: 1.5 },
    { id: 4, label: "4×", name: "Blistering", secondsPerDay: 0.5 },
];

export const DEFAULT_SPEED_ID = 2;

// How often, in real seconds, a tick should ideally land. Slow enough that a
// generation finishes before the next slice is due, fast enough that the world
// feels alive.
export const TARGET_TICK_SECONDS = 30;
const MIN_TICK_DAYS = 1;
const MAX_TICK_DAYS = 90;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// Floating-point slack, so 6.999999999 days counts as 7.
const EPSILON = 1e-9;

export const speedById = (id) =>
    REALTIME_SPEEDS.find((speed) => speed.id === Number(id)) ||
    REALTIME_SPEEDS.find((speed) => speed.id === DEFAULT_SPEED_ID);

export const nextSpeedId = (id) => {
    const index = REALTIME_SPEEDS.findIndex((speed) => speed.id === Number(id));
    return REALTIME_SPEEDS[(index + 1 + REALTIME_SPEEDS.length) % REALTIME_SPEEDS.length].id;
};

// Everything the driver needs to know about a speed step, derived once.
export const clockPlan = (speedId) => {
    const speed = speedById(speedId);
    const tickDays = clamp(Math.round(TARGET_TICK_SECONDS / speed.secondsPerDay), MIN_TICK_DAYS, MAX_TICK_DAYS);
    return {
        speed,
        secondsPerDay: speed.secondsPerDay,
        tickDays,
        // A single slice never covers more than two ticks' worth: past that the
        // event count the simulator is asked for stops being believable for the
        // span, and one slow generation would swallow a month of history.
        maxSliceDays: tickDays * 2,
        // Undispatched backlog cap. Hitting it stalls the clock — the calendar
        // stops advancing until the simulator catches up, which is far better
        // than letting the displayed date drift days ahead of the events.
        maxPendingDays: tickDays * 2,
    };
};

// Turn elapsed wall time into game days. Returns the new backlog and whether it
// was clipped by the cap (the UI shows that as "catching up").
export const advancePending = ({ pendingDays = 0, elapsedMs = 0, secondsPerDay, maxPendingDays }) => {
    const perDay = Number(secondsPerDay) > 0 ? Number(secondsPerDay) : 1;
    const cap = Number(maxPendingDays) > 0 ? Number(maxPendingDays) : Infinity;
    const gained = Math.max(0, Number(elapsedMs) || 0) / 1000 / perDay;
    const raw = Math.max(0, Number(pendingDays) || 0) + gained;
    return {
        pendingDays: Math.min(raw, cap),
        stalled: raw > cap + EPSILON,
    };
};

// How many whole days the next slice should cover, or 0 to keep waiting.
// `force` is the player pressing on the world — a submitted order that should
// resolve now rather than at the end of the current tick — and always yields at
// least one day, because a jump of zero days is not a jump.
export const nextSlice = ({ pendingDays = 0, tickDays, maxSliceDays, force = false }) => {
    const backlog = Math.max(0, Number(pendingDays) || 0);
    const whole = Math.floor(backlog + EPSILON);
    if (force) {
        return clamp(Math.max(1, whole), 1, maxSliceDays);
    }
    if (backlog + EPSILON < tickDays) {
        return 0;
    }
    return clamp(Math.max(1, whole), 1, maxSliceDays);
};

// 0..1 fill of the current tick, for the progress bar under the transport bar.
export const tickProgress = ({ pendingDays = 0, tickDays }) => {
    const span = Number(tickDays) > 0 ? Number(tickDays) : 1;
    return clamp((Math.max(0, Number(pendingDays) || 0)) / span, 0, 1);
};

// Whole days the calendar is shown ahead of the last committed turn: the
// backlog waiting to be simulated plus the slice being simulated right now.
// Whole days only, because the game date itself only moves in whole days.
export const displayDayOffset = ({ pendingDays = 0, inFlightDays = 0 }) =>
    Math.floor(Math.max(0, Number(pendingDays) || 0) + Math.max(0, Number(inFlightDays) || 0) + EPSILON);
