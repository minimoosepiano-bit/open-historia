/*! Open Historia — real-time clock driver © 2026 Nicholas Krol, MIT (see src/Editor/LICENSE). */
// Real-time mode: press play and the calendar starts moving on its own, the
// simulator generating the events for each slice of time as it passes, orders
// resolving into the world while you watch instead of at the end of a jump.
//
// This module is the driver — a single module-level clock shared by the whole
// app (there is only ever one game running), the same singleton shape
// mapSettings.js uses, with a React hook beside the plain API. The scheduling
// arithmetic it runs on is pure and lives in runtime/realtimeCore.js.
//
// What a tick actually is: one call to simulateTimelineJump for the whole days
// that have accrued. Nothing about how a turn is produced, validated, applied,
// or rolled back changes in real-time mode — the same jump the "jump forward"
// panel runs, dispatched by a clock instead of by a click. That is deliberate:
// undo, event staging, espionage, chat creation and history consolidation all
// keep working, and a real-time game is still a normal save.
import { useEffect, useState } from "react";
import {
    DEFAULT_SPEED_ID,
    advancePending,
    clockPlan,
    displayDayOffset,
    nextSlice,
    nextSpeedId,
    speedById,
    tickProgress,
} from "../../runtime/realtimeCore.js";
import { isSimulationBusy, simulateTimelineJump } from "./gameplay.js";
import { readGameData } from "../../runtime/gameState.js";

const SPEED_STORAGE_KEY = "oh-realtime-speed";
// How often the clock wakes up to convert elapsed wall time into game days.
// Fine-grained enough that the tick progress bar moves smoothly, coarse enough
// to cost nothing.
const STEP_MS = 250;
// A wake-up longer than this is the machine having been asleep or the tab
// throttled to a crawl — never credit that as game time, or an overnight tab
// resumes by demanding a decade of history.
const MAX_STEP_MS = 4000;
// Two failures in a row means something is actually wrong (no API key, the
// provider is down); stop rather than burn a request every half minute.
const MAX_CONSECUTIVE_FAILURES = 2;

const readStoredSpeed = () => {
    try {
        const stored = Number(localStorage.getItem(SPEED_STORAGE_KEY));
        return speedById(stored).id;
    } catch {
        // Private-mode storage — the default speed is a fine answer.
        return DEFAULT_SPEED_ID;
    }
};

const state = {
    running: false,
    speedId: typeof localStorage === "undefined" ? DEFAULT_SPEED_ID : readStoredSpeed(),
    // Days accrued and not yet handed to the simulator.
    pendingDays: 0,
    // Days covered by the slice generating right now (0 when idle). Kept apart
    // from pendingDays so the backlog cap only ever measures undispatched time.
    inFlightDays: 0,
    // A player order wants the world to move NOW, not at the end of this tick.
    forceNext: false,
    // Wall time is not credited while the tab is hidden: a game should not run
    // up a bill in a background tab, and coming back to fifty generated turns
    // is nobody's idea of playing.
    frozen: false,
    stalled: false,
    // Why the clock stopped on its own, shown next to the play button.
    pausedReason: "",
    error: "",
    turns: 0,
};

let listeners = new Set();
let tickListeners = new Set();
let timer = null;
let lastStepAt = 0;
let failures = 0;
let activeController = null;

const snapshot = () => {
    const plan = clockPlan(state.speedId);
    return {
        running: state.running,
        busy: state.inFlightDays > 0,
        frozen: state.frozen,
        stalled: state.stalled,
        speed: plan.speed,
        speedId: state.speedId,
        tickDays: plan.tickDays,
        pendingDays: state.pendingDays,
        inFlightDays: state.inFlightDays,
        // Whole days the calendar is shown ahead of the last committed turn.
        dayOffset: displayDayOffset(state),
        progress: tickProgress({ pendingDays: state.pendingDays, tickDays: plan.tickDays }),
        pausedReason: state.pausedReason,
        error: state.error,
        turns: state.turns,
    };
};

let current = snapshot();

const emit = () => {
    current = snapshot();
    for (const listener of listeners) {
        try {
            listener(current);
        } catch (error) {
            console.error("[realtime] subscriber threw:", error);
        }
    }
};

export const getRealtimeState = () => current;

export const subscribeRealtime = (listener) => {
    listeners.add(listener);
    listener(current);
    return () => listeners.delete(listener);
};

// Fired once per committed tick with the simulation result, so the UI can show
// the new date and events without waiting for its own polling read.
export const subscribeRealtimeTicks = (listener) => {
    tickListeners.add(listener);
    return () => tickListeners.delete(listener);
};

const emitTick = (result) => {
    for (const listener of tickListeners) {
        try {
            listener(result);
        } catch (error) {
            console.error("[realtime] tick subscriber threw:", error);
        }
    }
};

const dispatchSlice = async (days) => {
    state.inFlightDays = days;
    state.error = "";
    emit();

    const controller = new AbortController();
    activeController = controller;
    try {
        const result = await simulateTimelineJump({ days, signal: controller.signal });
        // Only the days that were actually simulated leave the backlog. Whatever
        // accrued while the model was thinking stays queued for the next slice,
        // which is why the displayed date never jumps backwards on a commit.
        state.pendingDays = Math.max(0, state.pendingDays - days);
        state.turns += 1;
        failures = 0;
        emitTick(result);
    } catch (error) {
        if (controller.signal.aborted || error?.name === "AbortError") {
            // Cancelled on purpose (paused mid-generation, or the player took the
            // wheel with a manual jump). Nothing was written; keep the backlog.
        } else {
            failures += 1;
            console.error("[realtime] tick failed:", error);
            state.error = error?.message || "The simulation could not be generated.";
            if (failures >= MAX_CONSECUTIVE_FAILURES) {
                stopClock("The clock stopped after two failed turns.");
            }
        }
    } finally {
        activeController = null;
        state.inFlightDays = 0;
        emit();
        // A forced tick, or a backlog left over from a long generation, should
        // go straight back out rather than wait for the next 250ms step.
        maybeDispatch();
    }
};

const maybeDispatch = () => {
    if (!state.running || state.inFlightDays > 0) {
        return;
    }
    // Another AI task owns the world right now — a manual jump, a game-master
    // command, a catalyst stage. Two writers would clobber each other's turn.
    if (isSimulationBusy()) {
        return;
    }
    const plan = clockPlan(state.speedId);
    const days = nextSlice({
        pendingDays: state.pendingDays,
        tickDays: plan.tickDays,
        maxSliceDays: plan.maxSliceDays,
        force: state.forceNext,
    });
    if (days <= 0) {
        return;
    }
    // Consumed here, not when the slice finishes: an order submitted WHILE this
    // slice generates has to set the flag again and be served by the next one.
    state.forceNext = false;
    dispatchSlice(days);
};

const step = () => {
    const now = Date.now();
    const elapsed = Math.min(now - lastStepAt, MAX_STEP_MS);
    lastStepAt = now;

    const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
    if (hidden !== state.frozen) {
        state.frozen = hidden;
        emit();
    }
    if (hidden) {
        return;
    }

    const plan = clockPlan(state.speedId);
    const advanced = advancePending({
        pendingDays: state.pendingDays,
        elapsedMs: elapsed,
        secondsPerDay: plan.secondsPerDay,
        maxPendingDays: plan.maxPendingDays,
    });
    const changed = advanced.pendingDays !== state.pendingDays || advanced.stalled !== state.stalled;
    state.pendingDays = advanced.pendingDays;
    state.stalled = advanced.stalled;
    if (changed) {
        emit();
    }
    maybeDispatch();
};

const startClock = () => {
    if (timer) {
        return;
    }
    lastStepAt = Date.now();
    timer = setInterval(step, STEP_MS);
};

const stopClock = (reason = "") => {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
    // Only a clock that was running can have a reason for having stopped —
    // otherwise "Paused for a manual jump" would greet a player who has never
    // started it.
    if (state.running) {
        state.pausedReason = reason;
    }
    state.running = false;
    state.stalled = false;
    state.forceNext = false;
};

// ---- Public controls --------------------------------------------------------

export const startRealtime = async () => {
    if (state.running) {
        return true;
    }
    // Nothing to simulate without a game loaded — say so instead of firing a
    // turn at an empty world.
    try {
        const game = await readGameData({ force: true });
        if (!game?.gameDate && !game?.startDate) {
            state.error = "Load or start a game before running the clock.";
            emit();
            return false;
        }
    } catch {
        // A failed read is not proof there is no game; let the first tick decide.
    }
    failures = 0;
    state.running = true;
    state.error = "";
    state.pausedReason = "";
    state.stalled = false;
    startClock();
    emit();
    return true;
};

// `cancelInFlight` abandons the turn being generated instead of letting it
// commit — what the Cancel button next to "Simulating…" does. A plain pause
// lets the current slice finish, so no generated history is thrown away.
export const pauseRealtime = ({ reason = "", cancelInFlight = false } = {}) => {
    stopClock(reason);
    if (cancelInFlight) {
        cancelRealtimeTick();
    }
    emit();
};

export const toggleRealtime = async () => {
    if (state.running) {
        pauseRealtime();
        return false;
    }
    return startRealtime();
};

export const cancelRealtimeTick = () => {
    activeController?.abort(new DOMException("Real-time tick cancelled.", "AbortError"));
};

export const setRealtimeSpeed = (speedId) => {
    state.speedId = speedById(speedId).id;
    try {
        localStorage.setItem(SPEED_STORAGE_KEY, String(state.speedId));
    } catch {
        // Private-mode storage — the speed just won't be remembered.
    }
    // A slower speed can put the backlog over the new cap; clip it so the
    // calendar doesn't sit stalled for minutes after a speed change.
    const plan = clockPlan(state.speedId);
    state.pendingDays = Math.min(state.pendingDays, plan.maxPendingDays);
    state.stalled = false;
    emit();
    maybeDispatch();
};

export const cycleRealtimeSpeed = () => setRealtimeSpeed(nextSpeedId(state.speedId));

// The player did something the world should answer for right away (submitted an
// order, took a decision). The next slice goes out as soon as the simulator is
// free, instead of at the end of the current tick. A no-op while paused —
// pausing means the world is not moving, and a queued order still resolves on
// the next tick or manual jump exactly as it always did.
export const requestRealtimeTick = () => {
    if (!state.running) {
        return false;
    }
    state.forceNext = true;
    emit();
    maybeDispatch();
    return true;
};

// ---- Ambient guards ---------------------------------------------------------

if (typeof window !== "undefined") {
    // Opening the main menu means the player is leaving the board — switching
    // games, editing a scenario, starting a new one. Never keep simulating the
    // game they just walked away from.
    window.addEventListener("oh:main-menu", (event) => {
        if (event?.detail?.open && state.running) {
            pauseRealtime({ reason: "Paused while the menu is open." });
        }
    });
    // Credit no wall time across a hidden tab: reset the step baseline on the
    // way back so the first visible step measures from now, not from when the
    // tab was buried.
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
            lastStepAt = Date.now();
        }
    });
}

// ---- React binding ----------------------------------------------------------

export const useRealtimeClock = () => {
    const [value, setValue] = useState(current);
    useEffect(() => subscribeRealtime(setValue), []);
    return value;
};
