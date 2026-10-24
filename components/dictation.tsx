"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2Icon, MicIcon } from "lucide-react";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { Hint } from "@/components/ui/hint";

import { dictationResponse, MAX_DICTATION_PCM_BYTES, pcmWave } from "@/src/core";

/** Dictation uses local PCM capture and the configured LiteLLM transcription route. */
/** Meter tuning — the owner's tested values, see the file header. */
const METER_FLOOR_DB = -50;
const METER_CEILING_DB = -10;
export const METER_TICK_MS = 60;
/** Rolling history: 48 cells × 60ms ≈ 2.9s of recent loudness. */
export const METER_CELLS = 48;

export const DICTATION_KEY_ID = "LITELLM_API_KEY";
export const DICTATION_KEYLESS = "Dictation needs the LiteLLM connection";

/* Persistent capture graph (mitigation C, owner 2026-09-27): one
 * app-lifetime AudioContext + a module-load memo. Created under the
 * click gesture (autoplay policy) and NEVER closed — per-run nodes
 * (source, worklet) disconnect at teardown instead. */
let sharedCtx: AudioContext | null = null;
let workletModule: Promise<void> | null = null;

function ensureAudioGraph(): { ctx: AudioContext; module: Promise<void> } {
	if (!sharedCtx) sharedCtx = new AudioContext({ sampleRate: 16000 });
	if (!workletModule) {
		workletModule = sharedCtx.audioWorklet.addModule("/worklets/pcm-capture.js").catch((e: unknown) => {
			workletModule = null; // failed load: retry next run
			throw e;
		});
	}
	return { ctx: sharedCtx, module: workletModule };
}

/** RMS (0..1) → normalized 0..1 across the audible dB window. */
export function rmsToMeter(rms: number): number {
	if (rms <= 0) return 0;
	const db = 20 * Math.log10(rms);
	const t = (db - METER_FLOOR_DB) / (METER_CEILING_DB - METER_FLOOR_DB);
	return Math.max(0, Math.min(1, t));
}

/**
 * The primary-input registry: at most ONE non-composer input can claim the
 * dictation target while mounted — the pending question's answer/thinking
 * field (question-dock.tsx). The page's `append` (the composer) is the
 * fallback when nobody claims. Module-level by design: the claimant is a
 * sibling subtree far from the hook's owner, and there is exactly one
 * window, one pending question, one target at a time.
 */
let questionTarget: ((text: string) => void) | null = null;

/* Is a dictation run live on this page? The Esc chain (keyboard wave A,
 * components/keyboard-shortcuts.tsx) needs a SYNCHRONOUS answer — the
 * stop handler can't report back through a CustomEvent. Set at start(),
 * cleared in cleanup() (every terminal path runs through cleanup). */
let dictationActiveFlag = false;

export function isDictationActive(): boolean {
	return dictationActiveFlag;
}

/* The finisher registry: submit paths FAR from the hook's owner (the
 * pending question's dock) need finish() without a prop bridge. Same
 * module-level pattern as questionTarget — one window, one instance,
 * one finisher. Empty registry (no hook mounted) → resolve immediately. */
let dictationFinisher: (() => Promise<void>) | null = null;

/** Finish any live dictation run before continuing (see Dictation.finish). */
export function finishDictation(): Promise<void> {
	return dictationFinisher ? dictationFinisher() : Promise.resolve();
}

/** Join a dictated final onto the current text (shared separator rule). */
export function joinDictation(current: string, final: string): string {
	return current ? current.replace(/\s+$/, "") + " " + final : final;
}

/**
 * Claim the dictation target while mounted (and `claimed` is true). The
 * unmount guard is identity-based so dev-mode double-invoked effects
 * can't clear another claimant.
 */
export function useDictationTarget(append: (text: string) => void, claimed: boolean) {
	useEffect(() => {
		if (!claimed) return;
		questionTarget = append;
		return () => {
			if (questionTarget === append) questionTarget = null;
		};
	}, [append, claimed]);
}

export type DictationPhase = "idle" | "connecting" | "recording" | "stopping";

export type Dictation = {
	phase: DictationPhase;
	/** Terminal-state explanation, shown inside the wide button (cleared on the next start). */
	error: string | null;
	/** Latest observed RMS, 0..1 — sampled by the meter's own tick, never reset. */
	levelRef: { current: number };
	/** Not idle — from the click until the stop completes (the optimistic window). */
	active: boolean;
	/** End + KEEP the transcript: flush the deferred buffer into the primary
	 *  input (the Stop pill and ⌘D). */
	toggle: () => void;
	stop: () => void;
	/** FINISH, THEN CONTINUE (owner, 2026-10-01 "nothing gets lost" round):
	 *  if a run is live, stop it and resolve only when the run has fully
	 *  ended — the final transcription has landed in the target field. A
	 *  submit path awaits this before building its payload, so a learner
	 *  who forgets to stop dictation before Enter never loses the spoken
	 *  reasoning. Idle → resolves immediately (the common no-run submit
	 *  pays nothing). Every terminal path runs cleanup(), and cleanup()
	 *  resolves the waiters — cancel (Esc) resolves them too, by its
	 *  discard semantics. */
	finish: () => Promise<void>;
	/** End + DISCARD the transcript: no flush, immediate teardown. The Esc
	 *  semantics (owner, 2026-09-17 round 3): Esc is a cancel, not a stop —
	 *  before, it flushed exactly like the toggle did. */
	cancel: () => void;
	/** Clear the terminal error without starting a run (zero-keys wave):
	 * the keyless click leaves for Settings and the surface must come
	 * back clean. */
	clearError: () => void;
};

/** Capture locally, stop the microphone, then send one WAV through the app server. */
export function useDictation({ append }: { append: (text: string) => void }): Dictation {
	const [phase, setPhase] = useState<DictationPhase>("idle");
	const phaseRef = useRef<DictationPhase>("idle");
	const [error, setError] = useState<string | null>(null);
	const levelRef = useRef(0);
	const appendRef = useRef(append);
	appendRef.current = append;
	const genRef = useRef(0);
	const streamRef = useRef<MediaStream | null>(null);
	const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
	const workletRef = useRef<AudioWorkletNode | null>(null);
	const framesRef = useRef<Int16Array[]>([]);
	const bytesRef = useRef(0);
	const bufferRef = useRef<string[]>([]);
	const abortRef = useRef<AbortController | null>(null);
	const waitersRef = useRef<Array<() => void>>([]);
	const flushResolveRef = useRef<(() => void) | null>(null);
	const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const changePhase = useCallback((next: DictationPhase) => {
		phaseRef.current = next;
		setPhase(next);
	}, []);
	const stopMic = useCallback(() => {
		for (const track of streamRef.current?.getTracks() ?? []) track.stop();
		streamRef.current = null;
		sourceRef.current?.disconnect();
		sourceRef.current = null;
	}, []);
	const cleanup = useCallback(() => {
		genRef.current++;
		dictationActiveFlag = false;
		stopMic();
		workletRef.current?.disconnect();
		workletRef.current = null;
		abortRef.current?.abort();
		abortRef.current = null;
		if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
		flushResolveRef.current?.();
		flushResolveRef.current = null;
		framesRef.current = [];
		bytesRef.current = 0;
		const text = bufferRef.current.join(" ");
		bufferRef.current = [];
		if (text) (questionTarget ?? appendRef.current)(text);
		changePhase("idle");
		for (const resolve of waitersRef.current.splice(0)) resolve();
	}, [changePhase, stopMic]);

	const start = useCallback(async () => {
		if (phaseRef.current !== "idle") return;
		dictationActiveFlag = true;
		setError(null);
		changePhase("connecting");
		const gen = ++genRef.current;
		const ready = fetch("/api/stt/transcribe").then((res) => {
			if (!res.ok) throw new Error(res.status === 503 ? DICTATION_KEYLESS : "Dictation is unavailable");
		});
		ready.catch(() => {});
		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
			});
			if (gen !== genRef.current) {
				for (const track of stream.getTracks()) track.stop();
				return;
			}
			streamRef.current = stream;
			await ready;
			const { ctx, module } = ensureAudioGraph();
			await module;
			if (ctx.state === "suspended") await ctx.resume();
			if (gen !== genRef.current) return;
			const worklet = new AudioWorkletNode(ctx, "pcm-capture");
			workletRef.current = worklet;
			worklet.port.onmessage = (event) => {
				if (gen !== genRef.current) return;
				const msg: unknown = event.data;
				if (!msg || typeof msg !== "object" || !("type" in msg)) return;
				if (msg.type === "level" && "rms" in msg && typeof msg.rms === "number") {
					levelRef.current = msg.rms;
				} else if (msg.type === "flushed") {
					flushResolveRef.current?.();
				} else if (msg.type === "audio" && "buffer" in msg && msg.buffer instanceof Int16Array) {
					bytesRef.current += msg.buffer.byteLength;
					if (bytesRef.current > MAX_DICTATION_PCM_BYTES) {
						setError("Recording is too long");
						cleanup();
						return;
					}
					framesRef.current.push(msg.buffer);
				}
			};
			const source = ctx.createMediaStreamSource(stream);
			sourceRef.current = source;
			source.connect(worklet);
			worklet.connect(ctx.destination);
			changePhase("recording");
		} catch (cause) {
			if (gen !== genRef.current) return;
			setError(cause instanceof DOMException && cause.name === "NotAllowedError"
				? "Microphone permission denied" : cause instanceof Error ? cause.message : "Microphone unavailable");
			cleanup();
		}
	}, [changePhase, cleanup]);

	const stop = useCallback(async () => {
		if (phaseRef.current !== "recording" && phaseRef.current !== "connecting") return;
		const gen = genRef.current;
		changePhase("stopping");
		stopMic();
		const worklet = workletRef.current;
		if (!worklet) { cleanup(); return; }
		try {
			// Worklet messages are ordered: every captured sample, including the
			// partial final frame, arrives before the acknowledgement.
			await new Promise<void>((resolve, reject) => {
				flushResolveRef.current = resolve;
				flushTimerRef.current = setTimeout(() => reject(new Error("Audio capture did not finish")), 2000);
				worklet.port.postMessage({ type: "flush" });
			});
			if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
			flushResolveRef.current = null;
			if (gen !== genRef.current) return;
			worklet.disconnect();
			workletRef.current = null;
			if (framesRef.current.length === 0) { cleanup(); return; }
			const upload = new FormData();
			upload.set("file", pcmWave(framesRef.current, sharedCtx!.sampleRate), "dictation.wav");
			const controller = new AbortController();
			abortRef.current = controller;
			const response = await fetch("/api/stt/transcribe", { method: "POST", body: upload, signal: controller.signal });
			const result = dictationResponse(await response.json());
			if (gen !== genRef.current) return;
			if (!response.ok || result.text === undefined) throw new Error(result.message ?? "Dictation failed");
			if (result.text) bufferRef.current.push(result.text);
		} catch (cause) {
			if (gen !== genRef.current) return;
			setError(cause instanceof Error ? cause.message : "Dictation failed");
		} finally {
			if (gen === genRef.current) cleanup();
		}
	}, [changePhase, cleanup, stopMic]);

	const cancel = useCallback(() => {
		if (phaseRef.current === "idle") return;
		bufferRef.current = [];
		cleanup();
	}, [cleanup]);
	const finish = useCallback(() => new Promise<void>((resolve) => {
		if (phaseRef.current === "idle") { resolve(); return; }
		waitersRef.current.push(resolve);
		if (phaseRef.current !== "stopping") void stop();
	}), [stop]);
	const toggle = useCallback(() => {
		if (phaseRef.current === "idle") void start();
		else void stop();
	}, [start, stop]);
	useEffect(() => {
		dictationFinisher = finish;
		return () => { if (dictationFinisher === finish) dictationFinisher = null; };
	}, [finish]);
	useEffect(() => {
		window.addEventListener("lh:kbd-toggle-dictation", toggle);
		window.addEventListener("lh:kbd-cancel-dictation", cancel);
		return () => {
			window.removeEventListener("lh:kbd-toggle-dictation", toggle);
			window.removeEventListener("lh:kbd-cancel-dictation", cancel);
		};
	}, [toggle, cancel]);
	useEffect(() => () => { bufferRef.current = []; cleanup(); }, [cleanup]);
	return { phase, error, levelRef, active: phase !== "idle", toggle, stop, finish, cancel, clearError: () => setError(null) };
}

/**
 * The stats-bar dictation slot (owner placement, round 1): the row's middle
 * is one strip that is always the full free width —
 *
 *   idle      a wide, quiet "Dictate" button (mic + label, grayed out — the
 *             whole middle is the affordance, per the owner).
 *   active    optimistic from the CLICK: red stop pill + the fixed-width
 *             meter (no interim text ever shifts it). Spinner while
 *             the transcription request completes.
 *   error     the wide button again, label swapped for the failure reason
 *             (full text in the tooltip), cleared on the next click.
 */
export function DictationBar({ dictation }: { dictation: Dictation }) {
	const { phase, error, levelRef, toggle, active, clearError } = dictation;
	const { open: openSettings } = useSettingsDialog();
	/** The keyless click (zero-keys wave, owner dictation trio): the errored
	 *  idle button deep-links Settings → Keys → the LiteLLM row and clears
	 *  the error — the surface is clean when the user returns. Any other
	 *  error keeps the old behavior (click = retry, which clears). */
	const keyless = error === DICTATION_KEYLESS;
	const [levels, setLevels] = useState<number[]>(() => new Array(METER_CELLS).fill(0));
	const recording = phase === "recording" || phase === "stopping";
	/** Adaptive cell count (owner round 2): derived from the meter's
	 *  measured width — narrow rows show fewer bars instead of
	 *  overflowing under neighbors. */
	const [cellCount, setCellCount] = useState(METER_CELLS);
	const meterRef = useRef<HTMLDivElement | null>(null);

	// The meter's own heartbeat — 60ms samples of the level ref into a
	// rolling ring. Only THIS strip re-renders; the page never does.
	useEffect(() => {
		if (!active) return;
		setLevels(new Array(METER_CELLS).fill(0));
		const id = setInterval(() => {
			setLevels((ring) => {
				const next = ring.slice(1);
				next.push(rmsToMeter(levelRef.current));
				return next;
			});
		}, METER_TICK_MS);
		return () => clearInterval(id);
	}, [active, levelRef]);

	// Fit the cell count to the available width (4px pitch per cell:
	// 2px bar + 2px gap, clamped 8..48). The meter div's width is set by
	// the row's free space — cells carry no minimum width — so measuring
	// it once per activation + on resize keeps the strip honest in the
	// draft/home rows where the slider leaves little middle.
	useEffect(() => {
		if (!active) return;
		const el = meterRef.current;
		if (!el) return;
		const fit = () => {
			const w = el.clientWidth;
			setCellCount(Math.max(8, Math.min(METER_CELLS, Math.floor(w / 4))));
		};
		fit();
		const ro = new ResizeObserver(fit);
		ro.observe(el);
		return () => ro.disconnect();
	}, [active]);

	if (!active) {
		return (
			<Hint
				// Errored: the button span truncates the line — the tooltip is its
				// full reveal (the keyless line names the LiteLLM connection:
				// it's the Keys row label, the truth the user needs). Otherwise the
				// quiet label + the live ⌘D binding.
				label={error ?? "Dictate"}
				action={error ? undefined : "toggle-dictation"}
				side="top"
			>
				<button
					type="button"
					onClick={() => {
						if (keyless) {
							clearError();
							openSettings("keys", DICTATION_KEY_ID);
						} else {
							toggle();
						}
					}}
					aria-label={error ? `Dictation failed: ${error}` : "Start dictation"}
					data-testid="dictation-toggle"
				// Same blurring as the floating chrome (owner, fix wave round 3),
			// but lower opacity — the mic stays quieter than the model pills.
			className="flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-border/50 bg-card/50 text-xs text-muted-foreground/70 shadow-lg backdrop-blur transition-colors hover:border-border hover:text-muted-foreground"
			>
					<MicIcon className="size-3.5" />
					<span className="max-w-full truncate">{error ?? "Dictate"}</span>
				</button>
			</Hint>
		);
	}

	return (
		<div className="flex w-full min-w-0 items-center gap-2" data-testid="dictation-bar">
			<Hint
				// The owner flagged this copy good ("Stop dictation (Esc)") —
				// kept verbatim; only the machinery moved to the styled tooltip.
				label="Stop dictation (Esc)"
				side="top"
			>
				<button
					type="button"
					onClick={toggle}
					disabled={phase === "stopping"}
					aria-label="Stop dictation"
				data-testid="dictation-toggle"
				className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-destructive/10 px-2 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20"
			>
				{phase === "stopping" ? (
					<Loader2Icon className="size-3.5 animate-spin" />
				) : (
					<MicIcon className="size-3.5" />
				)}
					Stop
				</button>
			</Hint>
			<span className="size-1.5 shrink-0 animate-pulse rounded-full bg-destructive" aria-hidden />
			{/* Fixed width while recording — nothing ever appends text beside it
			    (no interims, owner round 1). Cells carry no minimum width; the
			    COUNT adapts to the measured row space (owner round 2). */}
			<div ref={meterRef} className="flex h-4 min-w-0 flex-1 items-center gap-[2px]" data-testid="dictation-meter">
				{levels.slice(-cellCount).map((v, i) => (
					<span
						key={i}
						className="min-w-0 flex-1 rounded-full bg-foreground/40"
						style={{ height: `${2 + Math.round(v * 14)}px` }}
					/>
				))}
			</div>
		</div>
	);
}
