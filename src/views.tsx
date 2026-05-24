import type { CSSProperties, FormEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { assertNever } from './core';
import { hasApiKey } from './llm';
import { getCurrentSession, signOut } from './supabase';
import { Chunk, ChunkId, EmphasisStyle, Passage, Settings, ThemeName } from './types';
import { buildEmptyPassage } from './app';
import type { AppAction, AppState, WordLookupUiState } from './app';

// === Shared view props ===

interface ViewProps {
  readonly state: AppState;
  readonly dispatch: (a: AppAction) => void;
}

// === Theme + emphasis picker (reused in library header and reading control bar) ===

const THEME_OPTIONS: ReadonlyArray<{ value: ThemeName; label: string }> = [
  { value: 'white', label: 'White' },
  { value: 'cream', label: 'Cream' },
  { value: 'sepia', label: 'Sepia' },
  { value: 'light-gray', label: 'Light gray' },
  { value: 'dark', label: 'Dark' },
  { value: 'high-contrast', label: 'High contrast' },
];

const EMPHASIS_OPTIONS: ReadonlyArray<{ value: EmphasisStyle; label: string }> = [
  { value: 'color', label: 'Color' },
  { value: 'bold', label: 'Bold' },
  { value: 'both', label: 'Both' },
  { value: 'none', label: 'None' },
];

function SettingsGearButton({ dispatch }: { dispatch: (a: AppAction) => void }) {
  return (
    <button
      type="button"
      className="ghost settings-gear"
      onClick={(e) => {
        e.currentTarget.blur();
        dispatch({ kind: 'toggle-settings' });
      }}
      aria-label="Open settings"
      title="Settings"
    >
      ⚙
    </button>
  );
}

function ThemePickers({
  theme,
  emphasisStyle,
  dispatch,
}: {
  theme: ThemeName;
  emphasisStyle: EmphasisStyle;
  dispatch: (a: AppAction) => void;
}) {
  return (
    <div className="theme-pickers">
      <label className="theme-picker" title="Color palette for the whole app">
        <span>Theme</span>
        <select
          value={theme}
          onChange={(e) =>
            dispatch({ kind: 'set-theme', theme: e.target.value as ThemeName })
          }
        >
          {THEME_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="theme-picker" title="How the currently-active chunk is marked">
        <span>Emphasis</span>
        <select
          value={emphasisStyle}
          onChange={(e) =>
            dispatch({
              kind: 'set-emphasis-style',
              style: e.target.value as EmphasisStyle,
            })
          }
        >
          {EMPHASIS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

// === Loading view (auth + library bootstrap) ===

export function LoadingView({ message }: { message: string }) {
  return (
    <main className="container">
      <h1>lang-tool</h1>
      <p className="muted">{message}</p>
    </main>
  );
}

// === Login view (username + password) ===

export function LoginView({
  onSignIn,
}: {
  onSignIn: (username: string, password: string) => Promise<void>;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<'idle' | 'signing-in' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const u = username.trim();
    if (u.length === 0 || password.length === 0) return;
    setStatus('signing-in');
    setError(null);
    try {
      await onSignIn(u, password);
      // The auth state listener in App will pick up the new session.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }

  return (
    <main className="container login-view">
      <h1>lang-tool</h1>
      <p className="muted">Sign in with your username and password.</p>
      <form className="login-form" onSubmit={submit}>
        <label className="login-label">
          <span>Username</span>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="ARD or DPD"
            autoComplete="username"
            autoCapitalize="characters"
            spellCheck={false}
            required
            autoFocus
          />
        </label>
        <label className="login-label">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error !== null && <div className="error-banner">{error}</div>}
        <button
          type="submit"
          disabled={
            status === 'signing-in' ||
            username.trim().length === 0 ||
            password.length === 0
          }
        >
          {status === 'signing-in' ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}

// === Settings modal ===

export function SettingsModal({ state, dispatch }: ViewProps) {
  const { voices: allVoices, ready: voicesReady } = useAvailableVoices();
  const spanishVoices = useMemo(
    () => allVoices.filter((v) => v.lang.toLowerCase().startsWith('es')),
    [allVoices],
  );
  const englishVoices = useMemo(
    () => allVoices.filter((v) => v.lang.toLowerCase().startsWith('en')),
    [allVoices],
  );
  // Resolve the active Spanish voice the same way ReadingView does, so the
  // VoiceIndicator in this modal reflects what would actually play.
  const activeSpanishVoice = useMemo(
    () =>
      resolveVoice(
        spanishVoices,
        state.learner.settings.ttsVoice,
        dialectToLang(state.learner.settings.dialect),
      ),
    [spanishVoices, state.learner.settings.ttsVoice, state.learner.settings.dialect],
  );

  // Escape closes the modal.
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        dispatch({ kind: 'toggle-settings' });
      }
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dispatch]);

  const settings = state.learner.settings;

  return (
    <div
      className="modal-backdrop"
      onClick={() => dispatch({ kind: 'toggle-settings' })}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h2>Settings</h2>
          <button
            type="button"
            className="modal-close"
            onClick={() => dispatch({ kind: 'toggle-settings' })}
            aria-label="Close settings"
          >
            ×
          </button>
        </header>

        <section className="modal-section">
          <h3>Pace</h3>
          <label className="pace" title="How fast Spanish is read aloud">
            <span className="pace-label">Spanish speech</span>
            <input
              type="range"
              min={0.5}
              max={2.0}
              step={0.1}
              value={settings.speechPaceMultiplier}
              onChange={(e) =>
                dispatch({
                  kind: 'set-speech-pace',
                  multiplier: Number(e.target.value),
                })
              }
            />
            <span className="pace-value">
              {settings.speechPaceMultiplier.toFixed(1)}×
            </span>
          </label>
          <label
            className={settings.englishTtsEnabled ? 'pace dimmed' : 'pace'}
            title={
              settings.englishTtsEnabled
                ? 'Inactive while English audio is on — the audio sets the pace.'
                : 'How long the English stays on screen before advancing'
            }
          >
            <span className="pace-label">Reading hold</span>
            <input
              type="range"
              min={0.5}
              max={2.0}
              step={0.1}
              value={settings.readPaceMultiplier}
              disabled={settings.englishTtsEnabled}
              onChange={(e) =>
                dispatch({
                  kind: 'set-read-pace',
                  multiplier: Number(e.target.value),
                })
              }
            />
            <span className="pace-value">
              {settings.readPaceMultiplier.toFixed(1)}×
            </span>
          </label>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={settings.englishTtsEnabled}
              onChange={() => dispatch({ kind: 'toggle-english-tts' })}
            />
            <span>Read the English gloss aloud</span>
          </label>
          <label className="pace" title="How fast English is read aloud">
            <span className="pace-label">English speech</span>
            <input
              type="range"
              min={0.5}
              max={2.0}
              step={0.1}
              value={settings.englishSpeechPaceMultiplier}
              disabled={!settings.englishTtsEnabled}
              onChange={(e) =>
                dispatch({
                  kind: 'set-english-speech-pace',
                  multiplier: Number(e.target.value),
                })
              }
            />
            <span className="pace-value">
              {settings.englishSpeechPaceMultiplier.toFixed(1)}×
            </span>
          </label>
        </section>

        <section className="modal-section">
          <h3>Voices</h3>
          <VoiceIndicator
            voice={activeSpanishVoice}
            spanishVoiceCount={spanishVoices.length}
            allVoices={allVoices}
            ready={voicesReady}
          />
          <VoiceSelect
            label="Spanish voice"
            value={settings.ttsVoice}
            voices={spanishVoices}
            emptyLabel="Auto (pick by dialect)"
            onChange={(name) => dispatch({ kind: 'set-tts-voice', voiceName: name })}
          />
          <VoiceSelect
            label="English voice"
            value={settings.englishTtsVoice}
            voices={englishVoices}
            emptyLabel="Auto (pick by language)"
            onChange={(name) =>
              dispatch({ kind: 'set-english-tts-voice', voiceName: name })
            }
          />
          <p className="muted small">
            Pick contrasting voices so the language switch is unmistakable — e.g. a male
            Spanish voice and a female English voice, or vice versa.
          </p>
        </section>

        <section className="modal-section">
          <h3>Spanish Re-read</h3>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={settings.reReadEnabled}
              onChange={() => dispatch({ kind: 'toggle-re-read' })}
            />
            <span>Read Spanish again after English</span>
          </label>
          {settings.reReadEnabled && (
            <>
              <VoiceSelect
                label="Re-read voice"
                value={settings.reReadVoice}
                voices={spanishVoices}
                emptyLabel="Same as Spanish voice"
                onChange={(name) =>
                  dispatch({ kind: 'set-re-read-voice', voiceName: name })
                }
              />
              <label
                className="pace"
                title="Speed of the second Spanish reading"
              >
                <span className="pace-label">Re-read pace</span>
                <input
                  type="range"
                  min={0.5}
                  max={2.0}
                  step={0.1}
                  value={settings.reReadPaceMultiplier}
                  onChange={(e) =>
                    dispatch({
                      kind: 'set-re-read-pace',
                      multiplier: Number(e.target.value),
                    })
                  }
                />
                <span className="pace-value">
                  {settings.reReadPaceMultiplier.toFixed(1)}×
                </span>
              </label>
              {settings.reReadVoice !== null && (
                <label
                  className="toggle-row"
                  title="Alternate which voice plays first on each sentence"
                >
                  <input
                    type="checkbox"
                    checked={settings.reReadAlternates}
                    onChange={() =>
                      dispatch({ kind: 'toggle-re-read-alternates' })
                    }
                  />
                  <span>Alternate which voice reads first (per sentence)</span>
                </label>
              )}
            </>
          )}
          <p className="muted small">
            Listen → check meaning → listen again. A second voice (e.g., opposite gender)
            trains your ear for varied speakers. Slower first reading + faster second is one
            common pattern; reverse it if you prefer.
          </p>
        </section>

        <section className="modal-section">
          <h3>Appearance</h3>
          <ThemePickers
            theme={settings.theme}
            emphasisStyle={settings.emphasisStyle}
            dispatch={dispatch}
          />
        </section>

        <section className="modal-section">
          <h3>Account</h3>
          <AccountSection />
        </section>
      </div>
    </div>
  );
}

function AccountSection() {
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    void getCurrentSession().then((s) => setEmail(s?.email ?? null));
  }, []);
  return (
    <div className="account-section">
      {email !== null && (
        <p className="muted small">
          Signed in as <strong>{email}</strong>
        </p>
      )}
      <button
        type="button"
        className="ghost"
        onClick={async () => {
          try {
            await signOut();
          } catch (e) {
            console.error('Sign-out failed', e);
          }
        }}
      >
        Sign out
      </button>
    </div>
  );
}

function VoiceSelect({
  label,
  value,
  voices,
  emptyLabel,
  onChange,
}: {
  label: string;
  value: string | null;
  voices: ReadonlyArray<SpeechSynthesisVoice>;
  emptyLabel: string;
  onChange: (name: string | null) => void;
}) {
  return (
    <label className="voice-select">
      <span>{label}</span>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
      >
        <option value="">{emptyLabel}</option>
        {voices.map((v) => (
          <option key={`${v.name}|${v.lang}`} value={v.name}>
            {v.name} ({v.lang})
          </option>
        ))}
      </select>
    </label>
  );
}

// === Library view ===

export function LibraryView({ state, dispatch }: ViewProps) {
  const passages = useMemo(
    () =>
      Object.values(state.learner.passages).sort(
        (a, b) => b.lastOpenedAt - a.lastOpenedAt,
      ),
    [state.learner.passages],
  );
  return (
    <main className="container">
      <header className="library-header">
        <h1>lang-tool</h1>
        <div className="header-actions">
          <SettingsGearButton dispatch={dispatch} />
          <button
            type="button"
            onClick={(e) => {
              e.currentTarget.blur();
              dispatch({ kind: 'reset-to-paste' });
            }}
          >
            + New passage
          </button>
        </div>
      </header>
      {passages.length === 0 ? (
        <p className="muted empty-library">
          No saved passages yet. Click <strong>+ New passage</strong> to paste your first one.
        </p>
      ) : (
        <ul className="passage-list">
          {passages.map((p) => (
            <PassageRow key={p.id} passage={p} dispatch={dispatch} />
          ))}
        </ul>
      )}
    </main>
  );
}

function PassageRow({
  passage,
  dispatch,
}: {
  passage: Passage;
  dispatch: (a: AppAction) => void;
}) {
  // Progress is measured in SENTENCES so the denominator is the full document
  // (passage.sentenceCount) rather than just the chunks that have been
  // translated so far. Otherwise a half-processed passage would always show
  // 99% as the reader catches up to whatever the LLM produced last.
  const totalSentences = passage.sentenceCount;
  const isFinished =
    passage.processingStatus.kind === 'complete' &&
    passage.lastReadChunkIndex >= passage.chunks.length;
  let sentencesRead = 0;
  if (isFinished) {
    sentencesRead = totalSentences;
  } else if (passage.chunks.length > 0) {
    const idx = Math.min(passage.lastReadChunkIndex, passage.chunks.length - 1);
    const cur = passage.chunks[idx];
    sentencesRead = cur ? cur.sentenceIndex : 0;
  }
  const percent =
    totalSentences > 0 ? Math.round((sentencesRead / totalSentences) * 100) : 0;
  const date = new Date(passage.lastOpenedAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  return (
    <li className="passage-row">
      <button
        type="button"
        className="passage-open"
        onClick={(e) => {
          e.currentTarget.blur();
          dispatch({ kind: 'open-passage', passageId: passage.id, now: Date.now() });
        }}
      >
        <span className="passage-title">{passage.title}</span>
        <span className="passage-meta">
          {percent}% · {date}
        </span>
      </button>
      <button
        type="button"
        className="ghost passage-delete"
        onClick={(e) => {
          e.currentTarget.blur();
          if (window.confirm(`Delete "${passage.title}"?`)) {
            dispatch({ kind: 'delete-passage', passageId: passage.id });
          }
        }}
        aria-label={`Delete ${passage.title}`}
      >
        Delete
      </button>
    </li>
  );
}

// === Paste view ===

export function PasteView({ state, dispatch }: ViewProps) {
  const canStart = state.ui.draftText.trim().length > 0;
  function onStart() {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const passage = buildEmptyPassage(state.ui.draftText);
    if (passage === null) return;
    dispatch({ kind: 'start-passage', passage });
  }
  function onSave() {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const passage = buildEmptyPassage(state.ui.draftText);
    if (passage === null) return;
    dispatch({ kind: 'save-passage', passage });
  }
  return (
    <main className="container">
      <h1>lang-tool</h1>
      <p className="muted">
        Paste a Spanish or English passage. English input is translated to Spanish; in either case
        you read, hear, and see chunked English meaning one piece at a time.
      </p>
      {!hasApiKey() && (
        <p className="muted small">
          No Anthropic API key set — using a fallback that splits on sentences with placeholder
          English. Add <code>VITE_ANTHROPIC_API_KEY</code> to <code>.env.local</code> and restart
          the dev server for real glosses.
        </p>
      )}
      {state.ui.processingError !== null && (
        <div className="error-banner">
          <strong>Couldn't process passage:</strong> {state.ui.processingError}
        </div>
      )}
      <textarea
        className="paste-box"
        value={state.ui.draftText}
        onChange={(e) => dispatch({ kind: 'set-draft', text: e.target.value })}
        placeholder="Pega aquí…"
        rows={12}
        spellCheck={false}
        lang="es"
      />
      <div className="actions">
        <button type="button" disabled={!canStart} onClick={onStart}>
          Start reading
        </button>
        <button
          type="button"
          className="ghost"
          disabled={!canStart}
          onClick={onSave}
          title="Save to library without starting to read"
        >
          Save
        </button>
        <button
          type="button"
          className="ghost"
          onClick={(e) => {
            e.currentTarget.blur();
            dispatch({ kind: 'go-to-library' });
          }}
        >
          ◀ Library
        </button>
      </div>
    </main>
  );
}

// === Processing view ===

export function ProcessingView({ state, dispatch }: ViewProps) {
  const preview = state.ui.draftText.slice(0, 200);
  const truncated = state.ui.draftText.length > 200;
  return (
    <main className="container">
      <h1>Processing…</h1>
      <p className="muted">
        {hasApiKey()
          ? 'Asking Claude to split the passage and gloss each chunk. This usually takes a few seconds.'
          : 'No API key set — using stub chunking. (This should be near-instant.)'}
      </p>
      <blockquote className="preview">
        {preview}
        {truncated ? '…' : ''}
      </blockquote>
      <div className="actions">
        <button
          type="button"
          className="ghost"
          onClick={() => dispatch({ kind: 'cancel-processing' })}
        >
          Cancel
        </button>
      </div>
    </main>
  );
}

// === Reading view ===

export function ReadingView({ state, dispatch }: ViewProps) {
  const { currentPassageId, spanishTtsDone, englishTtsDone, reReadDone, isPaused } =
    state.ui;
  const speechPaceMultiplier = state.learner.settings.speechPaceMultiplier;
  const readPaceMultiplier = state.learner.settings.readPaceMultiplier;
  const englishTtsEnabled = state.learner.settings.englishTtsEnabled;
  const englishSpeechPaceMultiplier = state.learner.settings.englishSpeechPaceMultiplier;
  const reReadEnabled = state.learner.settings.reReadEnabled;
  const reReadPaceMultiplier = state.learner.settings.reReadPaceMultiplier;
  const reReadAlternates = state.learner.settings.reReadAlternates;
  const settingsOpen = state.ui.settingsOpen;
  const dialect = state.learner.settings.dialect;

  const chosenSpanishVoice = state.learner.settings.ttsVoice;
  const chosenEnglishVoice = state.learner.settings.englishTtsVoice;
  const chosenReReadVoice = state.learner.settings.reReadVoice;
  const { voices: allVoices, ready: voicesReady } = useAvailableVoices();
  const spanishVoices = useMemo(
    () => allVoices.filter((v) => v.lang.toLowerCase().startsWith('es')),
    [allVoices],
  );
  const voice = useMemo(
    () => resolveVoice(spanishVoices, chosenSpanishVoice, dialectToLang(dialect)),
    [spanishVoices, chosenSpanishVoice, dialect],
  );
  const englishVoices = useMemo(
    () => allVoices.filter((v) => v.lang.toLowerCase().startsWith('en')),
    [allVoices],
  );
  const englishVoice = useMemo(
    () => resolveVoice(englishVoices, chosenEnglishVoice, 'en-US'),
    [englishVoices, chosenEnglishVoice],
  );
  // Re-read voice: falls back to the primary Spanish voice if the user hasn't
  // explicitly picked a contrasting one.
  const reReadVoice = useMemo(
    () =>
      chosenReReadVoice !== null
        ? (spanishVoices.find((v) => v.name === chosenReReadVoice) ?? voice)
        : voice,
    [spanishVoices, chosenReReadVoice, voice],
  );

  // Resolve current passage and chunk. Position is on the passage so it
  // persists across sessions, not on the UI state.
  const passage = currentPassageId !== null ? state.learner.passages[currentPassageId] : undefined;
  const currentChunkIndex = passage?.lastReadChunkIndex ?? 0;
  const currentChunk = passage?.chunks[currentChunkIndex];
  // Reached the end of currently-processed content. If the passage is still
  // being processed, we're "buffering" (waiting for next batch). If complete,
  // we're truly done with the passage.
  const reachedEndOfProcessed =
    passage !== undefined && currentChunkIndex >= passage.chunks.length;
  const passageStatus = passage?.processingStatus.kind ?? 'complete';
  const isDone = reachedEndOfProcessed && passageStatus === 'complete';
  const isBuffering = reachedEndOfProcessed && passageStatus === 'in-progress';
  const passageError =
    passage?.processingStatus.kind === 'error' ? passage.processingStatus.message : null;

  // Voice alternation: when enabled with a distinct re-read voice, swap which
  // voice plays first based on sentence parity. Even sentences: primary first.
  // Odd sentences: re-read voice first. Sub-chunks within one sentence keep
  // the same first/second mapping so the voice doesn't flip mid-sentence.
  const sentenceIdx = currentChunk?.sentenceIndex ?? 0;
  const swapVoices = reReadAlternates && sentenceIdx % 2 === 1;
  const firstVoice = swapVoices ? reReadVoice : voice;
  const secondVoice = swapVoices ? voice : reReadVoice;

  // Placeholder chunks (inserted when a batch was refused by the
  // translation service) have tlText starting with '['. TTS would say
  // "left bracket ellipsis right bracket" — useless. Detect and skip
  // speech entirely; the visual text is the only signal needed.
  const isPlaceholderChunk = currentChunk?.tlText.startsWith('[') ?? false;

  // Visual emphasis follows the audio. With re-read on, the highlight stays
  // on the Spanish cell from the start of re-read all the way through hold
  // and advance — so the eye moves straight down into the next chunk's
  // Spanish cell instead of flashing back to English first.
  let activeSide: 'tl' | 'en';
  if (!spanishTtsDone) {
    activeSide = 'tl';
  } else if (englishTtsEnabled && !englishTtsDone) {
    activeSide = 'en';
  } else if (reReadEnabled) {
    activeSide = 'tl';
  } else {
    activeSide = 'en';
  }

  const sentencesRef = useRef<HTMLOListElement | null>(null);
  // Fade-out state for the active row, just before auto-advance. The `<ol>`
  // gets inline --fade-duration-ms so CSS transitions match the timer.
  const [isFading, setIsFading] = useState(false);
  const [fadeMs, setFadeMs] = useState(0);

  // Per-phase speech controllers. Holding these in refs (rather than in
  // useEffect cleanup closures) lets us pause/resume the same utterance
  // across re-renders — the React effect lifecycle can't distinguish
  // "deps changed because chunk advanced" from "deps changed because user
  // hit pause", so we manage the lifetime explicitly.
  const spanishSpeechRef = useRef<SpeechController | null>(null);
  const englishSpeechRef = useRef<SpeechController | null>(null);
  const reReadSpeechRef = useRef<SpeechController | null>(null);

  // Cancel any in-flight utterance when the current chunk changes (or the
  // view unmounts). Runs BEFORE the phase-driver effects start the next
  // chunk's speech. We have to cancel all three because we may have been
  // paused mid-English or mid-re-read when the user clicked advance.
  useEffect(() => {
    return () => {
      const refs = [spanishSpeechRef, englishSpeechRef, reReadSpeechRef];
      for (const r of refs) {
        if (r.current && !r.current.isEnded()) {
          r.current.cancel();
        }
        r.current = null;
      }
    };
  }, [currentChunk?.id]);

  // Keep the active row (or the done message at end of passage) in view as
  // chunks advance, so the reader never has to manually scroll.
  useEffect(() => {
    const root = sentencesRef.current;
    if (!root) return;
    const target = isDone
      ? root.parentElement?.querySelector('.done')
      : root.querySelector('.pair-row.current');
    if (target instanceof HTMLElement) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [currentChunkIndex, isDone]);

  // Speak the Spanish chunk when it becomes current (or on replay). Pause
  // stops the utterance mid-word. On resume we re-speak the chunk from the
  // beginning rather than calling synth.resume() — Chrome's resume()
  // silently fails after a few seconds paused, which produced the "pressed
  // resume but nothing happens" bug. Re-speaking is reliable; the cost is
  // re-hearing whatever you already heard of the current chunk.
  useEffect(() => {
    if (!currentChunk) return;
    if (spanishTtsDone) return;

    if (settingsOpen) {
      if (spanishSpeechRef.current && !spanishSpeechRef.current.isEnded()) {
        spanishSpeechRef.current.cancel();
      }
      spanishSpeechRef.current = null;
      return;
    }

    if (isPaused) {
      if (spanishSpeechRef.current && !spanishSpeechRef.current.isEnded()) {
        spanishSpeechRef.current.cancel();
      }
      spanishSpeechRef.current = null;
      return;
    }

    // Placeholder chunks: don't read aloud, just mark all speech phases as
    // done so auto-advance moves us past it without audio jargon.
    if (isPlaceholderChunk) {
      dispatch({ kind: 'spanish-tts-finished', chunkId: currentChunk.id });
      return;
    }

    // Coming out of pause (or starting fresh): always begin a new utterance.
    if (spanishSpeechRef.current) {
      spanishSpeechRef.current.cancel();
      spanishSpeechRef.current = null;
    }

    const chunkAtStart = currentChunk;
    const ttsRate = 0.85 * speechPaceMultiplier;
    spanishSpeechRef.current = speakChunk(
      currentChunk.tlText,
      firstVoice,
      ttsRate,
      speechPaceMultiplier,
      () => dispatch({ kind: 'spanish-tts-finished', chunkId: chunkAtStart.id }),
    );
  }, [
    currentChunk?.id,
    spanishTtsDone,
    isPaused,
    settingsOpen,
    isPlaceholderChunk,
    speechPaceMultiplier,
    firstVoice,
    dispatch,
  ]);

  // Speak the English gloss once Spanish TTS has finished — but only when the
  // user has turned English audio on.
  useEffect(() => {
    if (!currentChunk) return;
    if (!spanishTtsDone) return;
    if (englishTtsDone) return;
    if (!englishTtsEnabled) return;

    if (settingsOpen) {
      if (englishSpeechRef.current && !englishSpeechRef.current.isEnded()) {
        englishSpeechRef.current.cancel();
      }
      englishSpeechRef.current = null;
      return;
    }

    if (isPaused) {
      if (englishSpeechRef.current && !englishSpeechRef.current.isEnded()) {
        englishSpeechRef.current.cancel();
      }
      englishSpeechRef.current = null;
      return;
    }

    if (isPlaceholderChunk) {
      dispatch({ kind: 'english-tts-finished', chunkId: currentChunk.id });
      return;
    }

    // Coming out of pause: always begin a new utterance (see Spanish effect
    // for rationale — Chrome's resume() is unreliable).
    if (englishSpeechRef.current) {
      englishSpeechRef.current.cancel();
      englishSpeechRef.current = null;
    }

    const gloss = currentChunk.englishGloss;
    if (gloss === null || gloss.length === 0) {
      dispatch({ kind: 'english-tts-finished', chunkId: currentChunk.id });
      return;
    }
    const chunkAtStart = currentChunk;
    const ttsRate = 0.95 * englishSpeechPaceMultiplier;
    englishSpeechRef.current = speakChunk(
      gloss,
      englishVoice,
      ttsRate,
      englishSpeechPaceMultiplier,
      () => dispatch({ kind: 'english-tts-finished', chunkId: chunkAtStart.id }),
    );
  }, [
    currentChunk?.id,
    spanishTtsDone,
    englishTtsDone,
    englishTtsEnabled,
    isPaused,
    settingsOpen,
    isPlaceholderChunk,
    englishSpeechPaceMultiplier,
    englishVoice,
    dispatch,
  ]);

  // Speak the Spanish chunk a second time after the English phase has played.
  // Pedagogically: first hearing is comprehension challenge, English reveal
  // gives meaning, second hearing reinforces with meaning known. A contrasting
  // voice (e.g., opposite gender) also trains cross-speaker comprehension.
  useEffect(() => {
    if (!currentChunk) return;
    if (!reReadEnabled) return;
    if (!spanishTtsDone) return;
    if (englishTtsEnabled && !englishTtsDone) return;
    if (reReadDone) return;

    if (settingsOpen) {
      if (reReadSpeechRef.current && !reReadSpeechRef.current.isEnded()) {
        reReadSpeechRef.current.cancel();
      }
      reReadSpeechRef.current = null;
      return;
    }

    if (isPaused) {
      if (reReadSpeechRef.current && !reReadSpeechRef.current.isEnded()) {
        reReadSpeechRef.current.cancel();
      }
      reReadSpeechRef.current = null;
      return;
    }

    if (isPlaceholderChunk) {
      dispatch({ kind: 're-read-tts-finished', chunkId: currentChunk.id });
      return;
    }

    // Coming out of pause: always begin a new utterance (see Spanish effect
    // for rationale — Chrome's resume() is unreliable).
    if (reReadSpeechRef.current) {
      reReadSpeechRef.current.cancel();
      reReadSpeechRef.current = null;
    }

    const chunkAtStart = currentChunk;
    const ttsRate = 0.85 * reReadPaceMultiplier;
    reReadSpeechRef.current = speakChunk(
      currentChunk.tlText,
      secondVoice,
      ttsRate,
      reReadPaceMultiplier,
      () => dispatch({ kind: 're-read-tts-finished', chunkId: chunkAtStart.id }),
    );
  }, [
    currentChunk?.id,
    reReadEnabled,
    spanishTtsDone,
    englishTtsEnabled,
    englishTtsDone,
    reReadDone,
    isPaused,
    settingsOpen,
    isPlaceholderChunk,
    reReadPaceMultiplier,
    secondVoice,
    dispatch,
  ]);

  // Derived: all speech for the current chunk has played (or wasn't required).
  const allSpeechDoneForCurrentChunk =
    spanishTtsDone &&
    (!englishTtsEnabled || englishTtsDone) &&
    (!reReadEnabled || reReadDone);

  // Hold timer after speech is done, then advance. With English audio on the
  // user has already heard the meaning, so the hold collapses to a brief
  // breath; the reading-pace slider only matters for silent reading.
  //
  // Fade behavior: starting at the latest possible moment, fade the emphasis
  // out over a window of up to 500ms (capped so it never starts before 2/3 of
  // the hold time). This gives the reader a visual signal to hit space if
  // they want to stay on the chunk.
  useEffect(() => {
    if (!currentChunk) return;
    if (isPaused) return;
    if (settingsOpen) return;
    if (!allSpeechDoneForCurrentChunk) return;

    const holdMs = englishTtsEnabled ? 400 : holdMsForChunk(currentChunk, readPaceMultiplier);
    const fadeDuration = Math.min(500, Math.floor(holdMs / 3));
    const fadeStartDelay = holdMs - fadeDuration;
    setFadeMs(fadeDuration);

    const fadeTimer = window.setTimeout(() => setIsFading(true), fadeStartDelay);
    const advanceTimer = window.setTimeout(() => {
      // Reset the fade flag in the same callback so React batches it with the
      // advance dispatch — avoids a brief flash where the new chunk briefly
      // shows the .fading state inherited from the previous one.
      setIsFading(false);
      dispatch({ kind: 'advance' });
    }, holdMs);

    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(advanceTimer);
      setIsFading(false);
    };
  }, [
    currentChunk?.id,
    currentChunk?.tlText,
    currentChunk?.englishGloss,
    allSpeechDoneForCurrentChunk,
    isPaused,
    settingsOpen,
    readPaceMultiplier,
    englishTtsEnabled,
    dispatch,
  ]);

  // Keyboard shortcuts (space / arrows / R).
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName ?? '';
      if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;

      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        dispatch({ kind: 'toggle-pause' });
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        dispatch({ kind: 'advance' });
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        dispatch({ kind: 'go-back' });
      } else if (e.key === 'Home') {
        e.preventDefault();
        dispatch({ kind: 'jump-to-start' });
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        dispatch({ kind: 'replay-current' });
      }
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dispatch]);

  if (!passage) {
    return <ErrorView dispatch={dispatch} message="No passage loaded." />;
  }

  return (
    <main className="container">
      <div className="reading-sticky-top">
        <header className="reading-header">
          <h2 className="passage-title">{passage.title}</h2>
          <div className="header-actions">
            <SettingsGearButton dispatch={dispatch} />
            <button
              type="button"
              className="ghost"
              onClick={(e) => {
                e.currentTarget.blur();
                dispatch({ kind: 'go-to-library' });
              }}
            >
              ◀ Library
            </button>
          </div>
        </header>

        <ControlBar isPaused={isPaused} dispatch={dispatch} />
      </div>

      <ol
        className="sentences"
        ref={sentencesRef}
        style={{ '--fade-duration-ms': `${fadeMs}ms` } as CSSProperties}
      >
        {groupBySentence(passage.chunks)
          .filter((s) => s[0]!.index <= currentChunkIndex)
          .map((sentence) => (
            <SentenceItem
              key={sentence[0]!.id}
              sentence={sentence}
              currentChunkIndex={currentChunkIndex}
              spanishTtsDone={spanishTtsDone}
              activeSide={activeSide}
              isPaused={isPaused}
              isFading={isFading}
              wordLookup={state.ui.wordLookup}
              dispatch={dispatch}
            />
          ))}
      </ol>

      {isDone && (
        <div className="done">
          <p>Done with this passage.</p>
          <button
            type="button"
            onClick={(e) => {
              e.currentTarget.blur();
              dispatch({ kind: 'go-to-library' });
            }}
          >
            Back to library
          </button>
        </div>
      )}

      {isBuffering && (
        <div className="buffering" aria-live="polite">
          <p className="muted">Loading next chunks…</p>
        </div>
      )}

      {passageError !== null && (
        <div className="error-banner" role="alert">
          <span>{passageError}</span>
          {currentPassageId !== null && (
            <button
              type="button"
              className="retry-btn"
              onClick={() =>
                dispatch({
                  kind: 'retry-passage-processing',
                  passageId: currentPassageId,
                })
              }
            >
              Try again
            </button>
          )}
        </div>
      )}

      <KeyboardHint />
    </main>
  );
}

// === Per-sentence rendering ===

function groupBySentence(chunks: ReadonlyArray<Chunk>): ReadonlyArray<ReadonlyArray<Chunk>> {
  const groups: Chunk[][] = [];
  let lastSentence = -1;
  for (const c of chunks) {
    if (c.sentenceIndex !== lastSentence) {
      groups.push([c]);
      lastSentence = c.sentenceIndex;
    } else {
      groups[groups.length - 1]!.push(c);
    }
  }
  return groups;
}

interface SentenceItemProps {
  readonly sentence: ReadonlyArray<Chunk>;
  readonly currentChunkIndex: number;
  readonly spanishTtsDone: boolean;
  readonly activeSide: 'tl' | 'en';
  readonly isPaused: boolean;
  readonly isFading: boolean;
  readonly wordLookup: WordLookupUiState | null;
  readonly dispatch: (a: AppAction) => void;
}

function SentenceItem({
  sentence,
  currentChunkIndex,
  spanishTtsDone,
  activeSide,
  isPaused,
  isFading,
  wordLookup,
  dispatch,
}: SentenceItemProps) {
  const hasCurrent = sentence.some((c) => c.index === currentChunkIndex);
  const lookupInThisSentence =
    wordLookup !== null && sentence.some((c) => c.id === wordLookup.chunkId);

  if (!hasCurrent) {
    // Past sentence: flowing Spanish paragraph + flowing English paragraph.
    // Each chunk still renders separately under the hood so that taps on
    // words attribute to the correct chunkId; the spaces between chunks
    // make them visually contiguous.
    const enText = sentence
      .filter((c) => c.englishGloss !== null && c.englishGloss.length > 0)
      .map((c) => c.englishGloss)
      .join(' ');
    return (
      <li className="sentence past">
        <div className="tl">
          {sentence.map((c, i) => (
            <span key={c.id}>
              {i > 0 && ' '}
              <ClickableSpanish text={c.tlText} chunkId={c.id} dispatch={dispatch} />
            </span>
          ))}
        </div>
        {enText.length > 0 && <div className="en">{enText}</div>}
        {lookupInThisSentence && wordLookup && (
          <WordLookupPanel lookup={wordLookup} dispatch={dispatch} />
        )}
      </li>
    );
  }

  // Current sentence: paired rows so each chunk's Spanish sits next to its
  // English. The active row is emphasized; past rows of this same sentence
  // remain visible (dimmer) for in-sentence context.
  const visibleSubChunks = sentence.filter((c) => c.index <= currentChunkIndex);

  return (
    <li className="sentence current">
      <div className="pairs">
        {visibleSubChunks.map((c) => {
          const isCurrentSub = c.index === currentChunkIndex;
          const showGloss =
            !isCurrentSub || (spanishTtsDone && c.englishGloss !== null);
          let rowCls = isCurrentSub ? 'pair-row current' : 'pair-row past';
          if (isCurrentSub) {
            // Emphasis follows the audio through the playback sequence.
            rowCls += activeSide === 'tl' ? ' tl-active' : ' en-active';
          }
          if (isCurrentSub && isFading) rowCls += ' fading';
          return (
            <div key={c.id} className={rowCls}>
              <div className="pair-tl">
                <ClickableSpanish text={c.tlText} chunkId={c.id} dispatch={dispatch} />
              </div>
              <div className="pair-en">{showGloss ? c.englishGloss : ''}</div>
            </div>
          );
        })}
      </div>
      {lookupInThisSentence && wordLookup && (
        <WordLookupPanel lookup={wordLookup} dispatch={dispatch} />
      )}
      {isPaused && (
        <button
          type="button"
          className="paused-badge"
          onClick={(e) => {
            e.currentTarget.blur();
            dispatch({ kind: 'toggle-pause' });
          }}
          title="Resume from where you paused"
        >
          paused<span className="paused-hint"> — tap or space to resume</span>
        </button>
      )}
    </li>
  );
}

// === Control bar ===

interface ControlBarProps {
  readonly isPaused: boolean;
  readonly dispatch: (a: AppAction) => void;
}

function ControlBar({ isPaused, dispatch }: ControlBarProps) {
  return (
    <div className="control-bar">
      <button
        type="button"
        className="control"
        onClick={(e) => {
          e.currentTarget.blur();
          dispatch({ kind: 'toggle-pause' });
        }}
      >
        {isPaused ? '▶ Resume' : '⏸ Pause'}
      </button>
      <button
        type="button"
        className="control ghost"
        onClick={(e) => {
          e.currentTarget.blur();
          dispatch({ kind: 'jump-to-start' });
        }}
        aria-label="Back to start of passage"
        title="Back to start of passage (Home)"
      >
        ⏮
      </button>
      <button
        type="button"
        className="control ghost"
        onClick={(e) => {
          e.currentTarget.blur();
          dispatch({ kind: 'go-back' });
        }}
        aria-label="Previous chunk"
        title="Previous chunk (←)"
      >
        ◀
      </button>
      <button
        type="button"
        className="control ghost"
        onClick={(e) => {
          e.currentTarget.blur();
          dispatch({ kind: 'replay-current' });
        }}
        aria-label="Replay current chunk"
      >
        ↻
      </button>
      <button
        type="button"
        className="control ghost"
        onClick={(e) => {
          e.currentTarget.blur();
          dispatch({ kind: 'advance' });
        }}
        aria-label="Next chunk"
      >
        ▶
      </button>
    </div>
  );
}

function VoiceIndicator({
  voice,
  spanishVoiceCount,
  allVoices,
  ready,
}: {
  voice: SpeechSynthesisVoice | null;
  spanishVoiceCount: number;
  allVoices: ReadonlyArray<SpeechSynthesisVoice>;
  ready: boolean;
}) {
  // While voices are still loading (briefly, on initial page load in Chrome),
  // don't announce the negative. Just show a neutral "looking…" placeholder.
  if (!ready) {
    return <span className="voice-indicator">🔊 Looking for voices…</span>;
  }
  if (voice === null && spanishVoiceCount === 0) {
    return (
      <div className="voice-indicator voice-warn">
        <div>⚠ No Spanish voice ({allVoices.length} other voices installed)</div>
        {allVoices.length > 0 && (
          <details className="voice-list">
            <summary>show installed voices</summary>
            <ul>
              {allVoices.map((v) => (
                <li key={`${v.name}|${v.lang}`}>
                  {v.name} <span className="voice-lang">({v.lang})</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    );
  }
  return (
    <span className="voice-indicator" title={voice?.name ?? ''}>
      🔊 {voice ? `${voice.name} (${voice.lang})` : 'Loading…'}
    </span>
  );
}

function KeyboardHint() {
  return (
    <div className="kbd-hint">
      <span>
        <kbd>Space</kbd> pause · press again to advance
      </span>
      <span>
        <kbd>←</kbd> back
      </span>
      <span>
        <kbd>→</kbd> skip
      </span>
      <span>
        <kbd>Home</kbd> start
      </span>
      <span>
        <kbd>R</kbd> replay
      </span>
    </div>
  );
}

function ErrorView({
  dispatch,
  message,
}: {
  dispatch: (a: AppAction) => void;
  message: string;
}) {
  return (
    <main className="container">
      <p>{message}</p>
      <button type="button" onClick={() => dispatch({ kind: 'reset-to-paste' })}>
        Back to paste
      </button>
    </main>
  );
}

// === TTS helpers (shell-layer; pure-ish wrappers around Web Speech API) ===

// Returned by speakChunk so callers can pause/resume the in-flight utterance
// (true mid-word resume via Web Speech API) or cancel it outright. Replaces
// the older "cleanup function" return — we now need three distinct verbs
// because pause/resume must preserve the utterance, cancel must throw it
// away, and the React effect lifecycle alone can't distinguish those.
interface SpeechController {
  readonly pause: () => void;
  readonly resume: () => void;
  readonly cancel: () => void;
  readonly isEnded: () => boolean;
}

function speakChunk(
  text: string,
  voice: SpeechSynthesisVoice | null,
  rate: number,
  paceMultiplier: number,
  onEnd: () => void,
): SpeechController {
  // `cancelled` flips when the caller calls cancel(). `ended` flips when the
  // utterance itself naturally finishes or errors. cancel() uses `ended` to
  // decide whether to call synth.cancel() — calling cancel() on an idle synth
  // can leave Chrome in a state where the next speak() silently fails, which
  // was the bug behind re-read dropping after the first chunk.
  let cancelled = false;
  let ended = false;

  // If no voice is available, skip TTS entirely rather than reading with the
  // wrong-language pronunciation. Use a silent reading delay instead so the
  // flow still progresses. Pause/resume on the silent path uses Date.now()
  // accounting: when paused we record how much was left, on resume we set a
  // fresh timeout for the remaining time.
  if (typeof speechSynthesis === 'undefined' || voice === null) {
    const words = text.split(/\s+/).filter((w) => w.length > 0).length;
    const totalMs = Math.max(1500, words * 400) / paceMultiplier;
    let remainingMs = totalMs;
    let timerStart = Date.now();
    let timer: number | null = window.setTimeout(fire, totalMs);
    function fire() {
      timer = null;
      ended = true;
      if (!cancelled) onEnd();
    }
    return {
      pause: () => {
        if (timer === null || ended || cancelled) return;
        window.clearTimeout(timer);
        timer = null;
        remainingMs = Math.max(0, remainingMs - (Date.now() - timerStart));
      },
      resume: () => {
        if (timer !== null || ended || cancelled) return;
        timerStart = Date.now();
        timer = window.setTimeout(fire, remainingMs);
      },
      cancel: () => {
        cancelled = true;
        if (timer !== null) {
          window.clearTimeout(timer);
          timer = null;
        }
      },
      isEnded: () => ended,
    };
  }

  const u = new SpeechSynthesisUtterance(text);
  u.lang = voice.lang;
  u.voice = voice;
  u.rate = rate;
  u.onend = () => {
    ended = true;
    if (!cancelled) onEnd();
  };
  u.onerror = () => {
    ended = true;
    if (!cancelled) onEnd();
  };
  speechSynthesis.speak(u);
  return {
    pause: () => {
      if (ended || cancelled) return;
      // Web Speech pause() pauses the currently-speaking utterance. Even
      // though the API is "global", in practice we only ever have one
      // utterance active at a time across all three TTS phases.
      speechSynthesis.pause();
    },
    resume: () => {
      if (ended || cancelled) return;
      // resume() is a no-op if the synth isn't actually paused, so guarding
      // here isn't strictly necessary but makes the intent explicit.
      if (speechSynthesis.paused) speechSynthesis.resume();
    },
    cancel: () => {
      cancelled = true;
      if (!ended) {
        speechSynthesis.cancel();
      }
    },
    isEnded: () => ended,
  };
}

function pickPreferredVoice(
  voices: ReadonlyArray<SpeechSynthesisVoice>,
  preferLang: string,
): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null;
  const exact = voices.find((v) => v.lang === preferLang);
  if (exact) return exact;
  const prefix = (preferLang.split('-')[0] ?? '').toLowerCase();
  return (
    voices.find(
      (v) =>
        v.lang.toLowerCase() === prefix || v.lang.toLowerCase().startsWith(prefix + '-'),
    ) ?? null
  );
}

// Use the user's chosen voice if it's still available; otherwise fall back
// to auto-pick by preferred language. Saved voice name persists across
// voice list reloads (e.g., when Windows finishes installing a new voice).
function resolveVoice(
  voices: ReadonlyArray<SpeechSynthesisVoice>,
  chosenName: string | null,
  fallbackLang: string,
): SpeechSynthesisVoice | null {
  if (chosenName !== null) {
    const named = voices.find((v) => v.name === chosenName);
    if (named) return named;
  }
  return pickPreferredVoice(voices, fallbackLang);
}

interface VoicesState {
  readonly voices: ReadonlyArray<SpeechSynthesisVoice>;
  // ready=false during the brief window after page load when Chrome hasn't
  // yet populated speechSynthesis.getVoices() — without this flag we'd flash
  // a "no Spanish voice" warning even on devices that have voices installed.
  // Flips to true on the first voiceschanged event, or after a 5s timeout
  // (Android Chrome sometimes fires voiceschanged 3-5s after page load).
  readonly ready: boolean;
}

function useAvailableVoices(): VoicesState {
  const [voices, setVoices] = useState<ReadonlyArray<SpeechSynthesisVoice>>([]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (typeof speechSynthesis === 'undefined') {
      setReady(true);
      return;
    }
    function load(): void {
      const v = speechSynthesis.getVoices();
      setVoices(v);
      if (v.length > 0) setReady(true);
    }
    load();
    speechSynthesis.addEventListener('voiceschanged', load);
    // Fallback: if voiceschanged never fires (some platforms), give up
    // looking after 5 seconds and report what we have. Long enough to cover
    // slow Android Chrome page loads; short enough that a real "no voices"
    // device gets the warning before the user is staring at silence too long.
    const t = window.setTimeout(() => setReady(true), 5000);
    return () => {
      speechSynthesis.removeEventListener('voiceschanged', load);
      window.clearTimeout(t);
    };
  }, []);
  return { voices, ready };
}

// === Clickable Spanish + word lookup panel ===

// Tokenize a Spanish chunk into alternating word/non-word segments. Words
// are letters (including accented Spanish letters + ñ); non-word segments
// are punctuation/whitespace. We preserve everything so re-joining is
// lossless and visual flow is unchanged.
function tokenizeSpanish(text: string): Array<{ text: string; isWord: boolean }> {
  const tokens: Array<{ text: string; isWord: boolean }> = [];
  const re = /([A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+)|([^A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== undefined) tokens.push({ text: m[1], isWord: true });
    else if (m[2] !== undefined) tokens.push({ text: m[2], isWord: false });
  }
  return tokens;
}

function ClickableSpanish({
  text,
  chunkId,
  dispatch,
}: {
  text: string;
  chunkId: ChunkId;
  dispatch: (a: AppAction) => void;
}) {
  const tokens = useMemo(() => tokenizeSpanish(text), [text]);
  return (
    <>
      {tokens.map((t, i) =>
        t.isWord ? (
          <button
            key={i}
            type="button"
            className="word-clickable"
            onClick={(e) => {
              e.stopPropagation();
              e.currentTarget.blur();
              dispatch({ kind: 'lookup-word', word: t.text, chunkId });
            }}
          >
            {t.text}
          </button>
        ) : (
          <span key={i}>{t.text}</span>
        ),
      )}
    </>
  );
}

function WordLookupPanel({
  lookup,
  dispatch,
}: {
  lookup: WordLookupUiState;
  dispatch: (a: AppAction) => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Scroll the panel into view on first appearance and again when it
  // transitions from loading → ready (since the panel grows then). 'nearest'
  // does the minimum scroll required, so it won't yank the page if the
  // panel is already visible.
  useEffect(() => {
    panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [lookup.kind]);
  return (
    <div
      ref={panelRef}
      className={`word-lookup-panel kind-${lookup.kind}`}
      role="dialog"
      aria-label="Word definition"
    >
      <div className="lookup-header">
        <span className="lookup-word">{lookup.word}</span>
        <button
          type="button"
          className="lookup-dismiss"
          onClick={(e) => {
            e.currentTarget.blur();
            dispatch({ kind: 'dismiss-lookup' });
          }}
          aria-label="Close definition"
          title="Close (audio stays paused — hit Resume to continue)"
        >
          ×
        </button>
      </div>
      {lookup.kind === 'loading' && (
        <div className="lookup-body lookup-loading">Looking up…</div>
      )}
      {lookup.kind === 'error' && (
        <div className="lookup-body lookup-error">{lookup.message}</div>
      )}
      {lookup.kind === 'ready' && (
        <div className="lookup-body">
          <div className="lookup-meaning">{lookup.definition.meaning}</div>
          {lookup.definition.verb && (
            <div className="lookup-verb">
              <div>
                <strong>{lookup.definition.verb.infinitive}</strong>
                {' — '}
                <em>{lookup.definition.verb.infinitiveEnglish}</em>
              </div>
              <div className="small">
                {lookup.definition.verb.tense}
                {' · '}
                {lookup.definition.verb.mood}
                {' · '}
                {lookup.definition.verb.person}
              </div>
            </div>
          )}
          {lookup.definition.idiom && (
            <div className="lookup-idiom">
              <div>
                <strong>{lookup.definition.idiom.expression}</strong>
              </div>
              <div>{lookup.definition.idiom.meaning}</div>
            </div>
          )}
          {lookup.definition.notes && (
            <div className="lookup-notes small">{lookup.definition.notes}</div>
          )}
        </div>
      )}
    </div>
  );
}

function holdMsForChunk(
  chunk: { readonly tlText: string; readonly englishGloss: string | null },
  readPaceMultiplier: number,
): number {
  // Hold scales with the gloss the learner is actually reading.
  // Fall back to Spanish word count if gloss is missing.
  const text =
    chunk.englishGloss !== null && chunk.englishGloss.length > 0
      ? chunk.englishGloss
      : chunk.tlText;
  const words = text.split(/\s+/).filter((w) => w.length > 0).length;
  const base = Math.max(1500, words * 300);
  return base / readPaceMultiplier;
}

function dialectToLang(d: Settings['dialect']): string {
  switch (d) {
    case 'es-MX':
      return 'es-MX';
    case 'es-ES':
      return 'es-ES';
    case 'es-neutral':
      return 'es';
    default:
      return assertNever(d);
  }
}
