import type { CSSProperties, FormEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  assertNever,
  compareChapters,
  computeResumeTarget,
  countSignificantWords,
  findNextChapter,
  isBookLikeFolder,
  passagePercentRead,
  splitBookIntoChapters,
} from './core';
import type { ResumeTarget } from './core';
import { hasApiKey } from './llm';
import { getCurrentSession, signOut } from './supabase';
import {
  ChapterSplit,
  Chunk,
  ChunkId,
  EmphasisStyle,
  Passage,
  ReadingMode,
  Settings,
  ThemeName,
} from './types';
import { buildEmptyPassage } from './app';
import type {
  AppAction,
  AppState,
  GrammarPanelUiState,
  WordLookupUiState,
} from './app';

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
            placeholder=""
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

        <details className="modal-section">
          <summary className="section-summary">
            <h3>Pace</h3>
          </summary>
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
        </details>

        <details className="modal-section">
          <summary className="section-summary">
            <h3>Voices</h3>
          </summary>
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
        </details>

        <details className="modal-section">
          <summary className="section-summary">
            <h3>Reading mode</h3>
            <span className="section-value">
              {settings.readingMode.charAt(0).toUpperCase() +
                settings.readingMode.slice(1)}
            </span>
          </summary>
          <div className="mode-picker" role="radiogroup" aria-label="Reading mode">
            <label className="mode-option">
              <input
                type="radio"
                name="reading-mode"
                checked={settings.readingMode === 'scaffolded'}
                onChange={() =>
                  dispatch({ kind: 'set-reading-mode', mode: 'scaffolded' })
                }
              />
              <span>Scaffolded</span>
            </label>
            <label className="mode-option">
              <input
                type="radio"
                name="reading-mode"
                checked={settings.readingMode === 'listening'}
                onChange={() =>
                  dispatch({ kind: 'set-reading-mode', mode: 'listening' })
                }
              />
              <span>Listening</span>
            </label>
            <label className="mode-option">
              <input
                type="radio"
                name="reading-mode"
                checked={settings.readingMode === 'light'}
                onChange={() =>
                  dispatch({ kind: 'set-reading-mode', mode: 'light' })
                }
              />
              <span>Light</span>
            </label>
            <label className="mode-option">
              <input
                type="radio"
                name="reading-mode"
                checked={settings.readingMode === 'reading'}
                onChange={() =>
                  dispatch({ kind: 'set-reading-mode', mode: 'reading' })
                }
              />
              <span>Reading</span>
            </label>
          </div>
          <p className="muted small">
            {settings.readingMode === 'scaffolded' &&
              'Spanish audio → Spanish text → English gloss → optional re-read, all automatic.'}
            {settings.readingMode === 'listening' &&
              'Each chunk plays in phases: (1) Spanish audio with the text hidden — pure listening test; (2) Spanish text appears and audio plays again; (3) English text appears (and plays if English aloud is on).'}
            {settings.readingMode === 'light' &&
              'Spanish audio plays once with the text visible, then waits. Tap Show English to see the gloss, then tap Continue (or press Space) to move on. Nothing advances on its own — you always drive.'}
            {settings.readingMode === 'reading' &&
              'Text-first and silent: the Spanish shows with no audio so you work out the meaning at your own pace. Tap a word to look it up, or Show English for the gloss; tap Continue (or press Space) to move on. Nothing auto-advances.'}
          </p>
          {settings.readingMode === 'reading' && (
            <label
              className="toggle-row"
              title="In Reading mode, play the chunk's Spanish audio once when you tap Continue, then advance when it finishes"
            >
              <input
                type="checkbox"
                checked={settings.readAloudOnAdvance}
                onChange={() =>
                  dispatch({ kind: 'toggle-read-aloud-on-advance' })
                }
              />
              <span>Play Spanish audio when advancing</span>
            </label>
          )}
          <div className="default-mode-row">
            <label className="voice-select">
              <span>Default on sign-in</span>
              <select
                value={settings.defaultReadingMode}
                onChange={(e) =>
                  dispatch({
                    kind: 'set-default-reading-mode',
                    mode: e.target.value as ReadingMode,
                  })
                }
              >
                <option value="scaffolded">Scaffolded</option>
                <option value="listening">Listening</option>
                <option value="light">Light</option>
                <option value="reading">Reading</option>
              </select>
            </label>
            <p className="muted small">
              The mode each fresh sign-in starts in. Changing it does not affect
              the current session selected above.
            </p>
          </div>
        </details>

        <details className="modal-section">
          <summary className="section-summary">
            <h3>Spanish Re-read</h3>
          </summary>
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
              <label
                className="toggle-row"
                title="When unchecked, very short chunks aren't worth re-reading and get skipped"
              >
                <input
                  type="checkbox"
                  checked={settings.reReadShortChunks}
                  onChange={() =>
                    dispatch({ kind: 'toggle-re-read-short-chunks' })
                  }
                />
                <span>Re-read short chunks (≤3 new words)</span>
              </label>
            </>
          )}
          <p className="muted small">
            Listen → check meaning → listen again. A second voice (e.g., opposite gender)
            trains your ear for varied speakers. Slower first reading + faster second is one
            common pattern; reverse it if you prefer.
          </p>
        </details>

        <details className="modal-section">
          <summary className="section-summary">
            <h3>Appearance</h3>
          </summary>
          <ThemePickers
            theme={settings.theme}
            emphasisStyle={settings.emphasisStyle}
            dispatch={dispatch}
          />
        </details>

        <details className="modal-section">
          <summary className="section-summary">
            <h3>Account</h3>
          </summary>
          <AccountSection />
        </details>
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

// Two-level folder tree assembled from the flat passage list.
interface FolderTree {
  readonly ungrouped: ReadonlyArray<Passage>;
  readonly folders: ReadonlyArray<{
    readonly name: string;
    readonly ungrouped: ReadonlyArray<Passage>;
    readonly subfolders: ReadonlyArray<{
      readonly name: string;
      readonly passages: ReadonlyArray<Passage>;
    }>;
  }>;
}

function groupByFolder(passages: ReadonlyArray<Passage>): FolderTree {
  const ungrouped: Passage[] = [];
  const folderMap = new Map<
    string,
    { ungrouped: Passage[]; subfolders: Map<string, Passage[]> }
  >();
  for (const p of passages) {
    if (p.folder === null) {
      ungrouped.push(p);
      continue;
    }
    let folder = folderMap.get(p.folder);
    if (!folder) {
      folder = { ungrouped: [], subfolders: new Map() };
      folderMap.set(p.folder, folder);
    }
    if (p.subfolder === null) {
      folder.ungrouped.push(p);
    } else {
      let sub = folder.subfolders.get(p.subfolder);
      if (!sub) {
        sub = [];
        folder.subfolders.set(p.subfolder, sub);
      }
      sub.push(p);
    }
  }
  const folders = Array.from(folderMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, { ungrouped: ung, subfolders }]) => ({
      name,
      ungrouped: ung,
      subfolders: Array.from(subfolders.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([sname, ps]) => ({ name: sname, passages: ps })),
    }));
  return { ungrouped, folders };
}

// All distinct folder names + their subfolder names. Used to populate
// the datalist suggestions on the move-passage inline form.
interface FolderCatalog {
  readonly folders: ReadonlyArray<string>;
  readonly subfoldersByFolder: ReadonlyMap<string, ReadonlyArray<string>>;
}

function buildFolderCatalog(passages: ReadonlyArray<Passage>): FolderCatalog {
  const folders = new Set<string>();
  const subs = new Map<string, Set<string>>();
  for (const p of passages) {
    if (p.folder === null) continue;
    folders.add(p.folder);
    if (p.subfolder !== null) {
      let s = subs.get(p.folder);
      if (!s) {
        s = new Set();
        subs.set(p.folder, s);
      }
      s.add(p.subfolder);
    }
  }
  const subfoldersByFolder = new Map<string, ReadonlyArray<string>>();
  for (const [folder, set] of subs) {
    subfoldersByFolder.set(folder, Array.from(set).sort());
  }
  return {
    folders: Array.from(folders).sort(),
    subfoldersByFolder,
  };
}

// "Resume reading" shortcut. Opens wherever the reader left off (or the next
// item, if they finished the last thing they read) and names it, so picking the
// app back up — on any device — is one tap. `variant` distinguishes the
// prominent library-wide bar from the lighter per-folder one.
function ResumeBar({
  target,
  dispatch,
  variant,
}: {
  target: ResumeTarget;
  dispatch: (a: AppAction) => void;
  variant: 'library' | 'folder';
}) {
  return (
    <button
      type="button"
      className={`resume-bar resume-bar-${variant}`}
      onClick={(e) => {
        e.currentTarget.blur();
        dispatch({
          kind: 'open-passage',
          passageId: target.passage.id,
          now: Date.now(),
        });
      }}
    >
      <span className="resume-bar-icon" aria-hidden="true">
        ↻
      </span>
      <span className="resume-bar-body">
        <span className="resume-bar-label">
          {target.advancedToNext ? 'Up next' : 'Resume reading'}
        </span>
        <span className="resume-bar-title">{target.passage.title}</span>
      </span>
    </button>
  );
}

export function LibraryView({ state, dispatch }: ViewProps) {
  const passages = useMemo(
    () =>
      Object.values(state.learner.passages).sort(
        (a, b) => b.lastOpenedAt - a.lastOpenedAt,
      ),
    [state.learner.passages],
  );
  const tree = useMemo(() => groupByFolder(passages), [passages]);
  const catalog = useMemo(() => buildFolderCatalog(passages), [passages]);
  // Most-recent reading position across the whole library, shown above the
  // document choices. Null when nothing is in progress (or the last item was
  // finished with nothing after it).
  const resumeTarget = useMemo(() => computeResumeTarget(passages), [passages]);

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
      {resumeTarget && (
        <ResumeBar target={resumeTarget} dispatch={dispatch} variant="library" />
      )}
      {passages.length === 0 ? (
        <p className="muted empty-library">
          No saved passages yet. Click <strong>+ New passage</strong> to paste your first one.
        </p>
      ) : (
        <>
          {tree.ungrouped.length > 0 && (
            <ul className="passage-list">
              {tree.ungrouped.map((p) => (
                <PassageRow
                  key={p.id}
                  passage={p}
                  catalog={catalog}
                  dispatch={dispatch}
                />
              ))}
            </ul>
          )}
          {tree.folders.map((f) =>
            f.subfolders.length === 0 && isBookLikeFolder(f.ungrouped) ? (
              <BookFolderGroup
                key={f.name}
                folder={f}
                catalog={catalog}
                dispatch={dispatch}
              />
            ) : (
              <FolderGroup
                key={f.name}
                folder={f}
                catalog={catalog}
                dispatch={dispatch}
              />
            ),
          )}
        </>
      )}
    </main>
  );
}

// Strong confirmation for the destructive "delete folder + all documents"
// action. There's no undo and no server-side point-in-time recovery, so spell
// out exactly what's about to be permanently deleted.
function confirmDeleteFolderContents(
  name: string,
  count: number,
  noun: 'passage' | 'chapter' = 'passage',
): boolean {
  const plural = count === 1 ? noun : `${noun}s`;
  return window.confirm(
    `Delete "${name}" and all ${count} ${plural} inside it?\n\n` +
      `This permanently deletes the document${count === 1 ? '' : 's'} — there is no undo.`,
  );
}

function FolderGroup({
  folder,
  catalog,
  dispatch,
}: {
  folder: {
    readonly name: string;
    readonly ungrouped: ReadonlyArray<Passage>;
    readonly subfolders: ReadonlyArray<{
      readonly name: string;
      readonly passages: ReadonlyArray<Passage>;
    }>;
  };
  catalog: FolderCatalog;
  dispatch: (a: AppAction) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const total =
    folder.ungrouped.length +
    folder.subfolders.reduce((n, s) => n + s.passages.length, 0);
  // Resume position scoped to this folder (its own passages + any subfolders).
  const folderPassages = useMemo(
    () => [
      ...folder.ungrouped,
      ...folder.subfolders.flatMap((s) => s.passages),
    ],
    [folder],
  );
  const resumeTarget = useMemo(
    () => computeResumeTarget(folderPassages),
    [folderPassages],
  );
  return (
    <section className="folder-group">
      <FolderHeader
        kind="folder"
        name={folder.name}
        count={total}
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        onRename={(newName) =>
          dispatch({
            kind: 'rename-folder',
            scope: 'folder',
            oldName: folder.name,
            newName,
          })
        }
        onDelete={() => {
          const ok = window.confirm(
            `Remove folder "${folder.name}"? Its ${total} passage${total === 1 ? '' : 's'} will move to the top level.`,
          );
          if (ok) {
            dispatch({
              kind: 'delete-folder',
              scope: 'folder',
              name: folder.name,
            });
          }
        }}
        onDeleteAll={() => {
          if (confirmDeleteFolderContents(folder.name, total)) {
            dispatch({
              kind: 'delete-folder-contents',
              scope: 'folder',
              name: folder.name,
            });
          }
        }}
      />
      {!collapsed && (
        <div className="folder-body">
          {resumeTarget && (
            <ResumeBar
              target={resumeTarget}
              dispatch={dispatch}
              variant="folder"
            />
          )}
          {folder.ungrouped.length > 0 && (
            <ul className="passage-list">
              {folder.ungrouped.map((p) => (
                <PassageRow
                  key={p.id}
                  passage={p}
                  catalog={catalog}
                  dispatch={dispatch}
                />
              ))}
            </ul>
          )}
          {folder.subfolders.map((s) => (
            <SubfolderGroup
              key={s.name}
              subfolder={s}
              parentFolder={folder.name}
              catalog={catalog}
              dispatch={dispatch}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// A folder that reads like a book (isBookLikeFolder). Collapsed, it shows a
// single compact book card with aggregate progress instead of a wall of
// chapter rows; tapping it drills into the chapter list. The expanded state
// reuses FolderHeader (so folder rename/remove still work, reached from the
// chapter list per the Task 7 spec) and renders compact ChapterRows. Chapters
// are ordered by parsed chapter number, not lastOpenedAt, so a book always
// reads top-to-bottom in document order.
function BookFolderGroup({
  folder,
  catalog,
  dispatch,
}: {
  folder: {
    readonly name: string;
    readonly ungrouped: ReadonlyArray<Passage>;
    readonly subfolders: ReadonlyArray<{
      readonly name: string;
      readonly passages: ReadonlyArray<Passage>;
    }>;
  };
  catalog: FolderCatalog;
  dispatch: (a: AppAction) => void;
}) {
  // Start as a card; expand to the chapter list on tap.
  const [collapsed, setCollapsed] = useState(true);
  const chapters = useMemo(
    () => [...folder.ungrouped].sort(compareChapters),
    [folder.ungrouped],
  );
  const n = chapters.length;
  const avgPercent =
    n > 0
      ? Math.round(
          chapters.reduce((sum, p) => sum + passagePercentRead(p), 0) / n,
        )
      : 0;
  // "Last opened chapter" = the most recently opened one; its position in the
  // ordered list is the chapter the reader is on. Falls back to 1 for a freshly
  // ingested book where every chapter shares the same lastOpenedAt.
  const lastOpened = chapters.reduce(
    (latest, p) => (p.lastOpenedAt > latest.lastOpenedAt ? p : latest),
    chapters[0]!,
  );
  const currentChapter = chapters.indexOf(lastOpened) + 1;
  const resumeTarget = useMemo(
    () => computeResumeTarget(chapters),
    [chapters],
  );

  if (collapsed) {
    return (
      <section className="folder-group book-group">
        <button
          type="button"
          className="book-card"
          onClick={(e) => {
            e.currentTarget.blur();
            setCollapsed(false);
          }}
          aria-label={`Open book ${folder.name}`}
        >
          <span className="book-card-icon" aria-hidden="true">
            📖
          </span>
          <span className="book-card-body">
            <span className="book-card-title">{folder.name}</span>
            <span className="book-card-meta">
              Chapter {currentChapter} of {n} · {avgPercent}% complete
            </span>
          </span>
        </button>
      </section>
    );
  }

  return (
    <section className="folder-group book-group">
      <FolderHeader
        kind="folder"
        name={folder.name}
        count={n}
        collapsed={false}
        onToggle={() => setCollapsed(true)}
        onRename={(newName) =>
          dispatch({
            kind: 'rename-folder',
            scope: 'folder',
            oldName: folder.name,
            newName,
          })
        }
        onDelete={() => {
          const ok = window.confirm(
            `Remove book "${folder.name}"? Its ${n} chapter${n === 1 ? '' : 's'} will move to the top level.`,
          );
          if (ok) {
            dispatch({
              kind: 'delete-folder',
              scope: 'folder',
              name: folder.name,
            });
          }
        }}
        onDeleteAll={() => {
          if (confirmDeleteFolderContents(folder.name, n, 'chapter')) {
            dispatch({
              kind: 'delete-folder-contents',
              scope: 'folder',
              name: folder.name,
            });
          }
        }}
      />
      <div className="folder-body">
        {resumeTarget && (
          <ResumeBar
            target={resumeTarget}
            dispatch={dispatch}
            variant="folder"
          />
        )}
        <ul className="passage-list chapter-list">
          {chapters.map((p) => (
            <ChapterRow
              key={p.id}
              passage={p}
              catalog={catalog}
              dispatch={dispatch}
            />
          ))}
        </ul>
      </div>
    </section>
  );
}

// One compact chapter row inside an expanded book. Tapping the row opens the
// chapter. The ⋯ kebab swaps the compact row for the full PassageRow, exposing
// the existing rename / move / delete actions without duplicating them.
function ChapterRow({
  passage,
  catalog,
  dispatch,
}: {
  passage: Passage;
  catalog: FolderCatalog;
  dispatch: (a: AppAction) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  if (menuOpen) {
    return (
      <>
        <PassageRow passage={passage} catalog={catalog} dispatch={dispatch} />
        <li className="chapter-menu-close">
          <button
            type="button"
            className="ghost"
            onClick={(e) => {
              e.currentTarget.blur();
              setMenuOpen(false);
            }}
          >
            Done
          </button>
        </li>
      </>
    );
  }
  const percent = passagePercentRead(passage);
  const date = new Date(passage.lastOpenedAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  return (
    <li className="passage-row chapter-row">
      <button
        type="button"
        className="passage-open chapter-open"
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
        className="ghost chapter-kebab"
        onClick={(e) => {
          e.currentTarget.blur();
          setMenuOpen(true);
        }}
        aria-label={`Actions for ${passage.title}`}
        title="Rename, move, or delete"
      >
        ⋯
      </button>
    </li>
  );
}

function SubfolderGroup({
  subfolder,
  parentFolder,
  catalog,
  dispatch,
}: {
  subfolder: { readonly name: string; readonly passages: ReadonlyArray<Passage> };
  parentFolder: string;
  catalog: FolderCatalog;
  dispatch: (a: AppAction) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const count = subfolder.passages.length;
  const resumeTarget = useMemo(
    () => computeResumeTarget(subfolder.passages),
    [subfolder.passages],
  );
  return (
    <section className="subfolder-group">
      <FolderHeader
        kind="subfolder"
        name={subfolder.name}
        count={count}
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        onRename={(newName) =>
          dispatch({
            kind: 'rename-folder',
            scope: 'subfolder',
            oldName: subfolder.name,
            newName,
            parentFolder,
          })
        }
        onDelete={() => {
          const ok = window.confirm(
            `Remove sub-folder "${subfolder.name}"? Its ${count} passage${count === 1 ? '' : 's'} will move up into "${parentFolder}".`,
          );
          if (ok) {
            dispatch({
              kind: 'delete-folder',
              scope: 'subfolder',
              name: subfolder.name,
              parentFolder,
            });
          }
        }}
        onDeleteAll={() => {
          if (confirmDeleteFolderContents(subfolder.name, count)) {
            dispatch({
              kind: 'delete-folder-contents',
              scope: 'subfolder',
              name: subfolder.name,
              parentFolder,
            });
          }
        }}
      />
      {!collapsed && (
        <>
          {resumeTarget && (
            <ResumeBar
              target={resumeTarget}
              dispatch={dispatch}
              variant="folder"
            />
          )}
          <ul className="passage-list">
            {subfolder.passages.map((p) => (
              <PassageRow
                key={p.id}
                passage={p}
                catalog={catalog}
                dispatch={dispatch}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// Shared header for both folder and sub-folder. Side buttons next to the
// collapsible header: rename (✎), remove (×, moves passages out), and a
// destructive delete (🗑, deletes the folder and everything in it). Clicking
// the name area toggles collapse; the side buttons stop propagation so they
// don't.
function FolderHeader({
  kind,
  name,
  count,
  collapsed,
  onToggle,
  onRename,
  onDelete,
  onDeleteAll,
}: {
  kind: 'folder' | 'subfolder';
  name: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  onRename: (newName: string) => void;
  onDelete: () => void;
  onDeleteAll: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(name);
  useEffect(() => {
    if (!renaming) setDraft(name);
  }, [name, renaming]);

  function commit() {
    const trimmed = draft.trim();
    if (trimmed.length > 0 && trimmed !== name) {
      onRename(trimmed);
    } else {
      setDraft(name);
    }
    setRenaming(false);
  }
  function cancel() {
    setDraft(name);
    setRenaming(false);
  }

  const headerCls = kind === 'folder' ? 'folder-header' : 'subfolder-header';

  if (renaming) {
    return (
      <div className={`${headerCls} renaming`}>
        <form
          className="folder-rename-form"
          onSubmit={(e) => {
            e.preventDefault();
            commit();
          }}
        >
          <input
            type="text"
            className="folder-name-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
              }
            }}
            onBlur={commit}
            autoFocus
            aria-label={`${kind === 'folder' ? 'Folder' : 'Sub-folder'} name`}
          />
          <button type="submit" className="ghost">
            Save
          </button>
          <button type="button" className="ghost" onClick={cancel}>
            Cancel
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className={headerCls}>
      <button
        type="button"
        className="folder-header-toggle"
        onClick={(e) => {
          e.currentTarget.blur();
          onToggle();
        }}
        aria-expanded={!collapsed}
      >
        <span className="folder-chevron">{collapsed ? '▶' : '▼'}</span>
        <span className="folder-name">{name}</span>
        <span className="folder-count">{count}</span>
      </button>
      <button
        type="button"
        className="ghost folder-rename-btn"
        onClick={(e) => {
          e.stopPropagation();
          e.currentTarget.blur();
          setRenaming(true);
        }}
        aria-label={`Rename ${name}`}
        title="Rename"
      >
        ✎
      </button>
      <button
        type="button"
        className="ghost folder-delete-btn"
        onClick={(e) => {
          e.stopPropagation();
          e.currentTarget.blur();
          onDelete();
        }}
        aria-label={`Remove ${name}`}
        title="Remove folder (passages move out, no data deleted)"
      >
        ×
      </button>
      <button
        type="button"
        className="ghost folder-delete-all-btn"
        onClick={(e) => {
          e.stopPropagation();
          e.currentTarget.blur();
          onDeleteAll();
        }}
        aria-label={`Delete ${name} and all its documents`}
        title="Delete folder AND all its documents (permanent, no undo)"
      >
        🗑
      </button>
    </div>
  );
}

function PassageRow({
  passage,
  catalog,
  dispatch,
}: {
  passage: Passage;
  catalog: FolderCatalog;
  dispatch: (a: AppAction) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [moving, setMoving] = useState(false);
  const [draftTitle, setDraftTitle] = useState(passage.title);
  const [draftFolder, setDraftFolder] = useState(passage.folder ?? '');
  const [draftSub, setDraftSub] = useState(passage.subfolder ?? '');
  // Keep draft in sync if the title changes externally (e.g., the Claude
  // title-suggestion effect updates it after a moment).
  useEffect(() => {
    if (!editing) setDraftTitle(passage.title);
  }, [passage.title, editing]);
  useEffect(() => {
    if (!moving) {
      setDraftFolder(passage.folder ?? '');
      setDraftSub(passage.subfolder ?? '');
    }
  }, [passage.folder, passage.subfolder, moving]);

  function commit() {
    const trimmed = draftTitle.trim();
    if (trimmed.length > 0 && trimmed !== passage.title) {
      dispatch({ kind: 'rename-passage', passageId: passage.id, title: trimmed });
    } else {
      setDraftTitle(passage.title);
    }
    setEditing(false);
  }
  function cancel() {
    setDraftTitle(passage.title);
    setEditing(false);
  }
  function commitMove() {
    const f = draftFolder.trim();
    const s = draftSub.trim();
    dispatch({
      kind: 'move-passage',
      passageId: passage.id,
      folder: f.length > 0 ? f : null,
      subfolder: s.length > 0 ? s : null,
    });
    setMoving(false);
  }
  function cancelMove() {
    setDraftFolder(passage.folder ?? '');
    setDraftSub(passage.subfolder ?? '');
    setMoving(false);
  }

  // Progress is measured in SENTENCES so the denominator is the full document
  // rather than just the chunks translated so far (see passagePercentRead).
  const percent = passagePercentRead(passage);
  const date = new Date(passage.lastOpenedAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });

  if (editing) {
    return (
      <li className="passage-row editing">
        <form
          className="passage-edit-form"
          onSubmit={(e) => {
            e.preventDefault();
            commit();
          }}
        >
          <input
            type="text"
            className="passage-title-input"
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
              }
            }}
            onBlur={commit}
            autoFocus
            aria-label="Passage title"
          />
          <button type="submit" className="ghost">
            Save
          </button>
          <button type="button" className="ghost" onClick={cancel}>
            Cancel
          </button>
        </form>
      </li>
    );
  }
  if (moving) {
    const folderListId = `folder-list-${passage.id}`;
    const subListId = `sub-list-${passage.id}`;
    const subSuggestions =
      catalog.subfoldersByFolder.get(draftFolder.trim()) ?? [];
    return (
      <li className="passage-row editing">
        <form
          className="passage-move-form"
          onSubmit={(e) => {
            e.preventDefault();
            commitMove();
          }}
        >
          <div className="passage-move-row">
            <span className="passage-title">{passage.title}</span>
          </div>
          <div className="passage-move-fields">
            <label className="passage-move-field">
              <span>Folder</span>
              <input
                type="text"
                list={folderListId}
                value={draftFolder}
                onChange={(e) => setDraftFolder(e.target.value)}
                placeholder="(top level)"
                autoFocus
              />
              <datalist id={folderListId}>
                {catalog.folders.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
            </label>
            <label className="passage-move-field">
              <span>Sub-folder</span>
              <input
                type="text"
                list={subListId}
                value={draftSub}
                onChange={(e) => setDraftSub(e.target.value)}
                placeholder={
                  draftFolder.trim().length === 0
                    ? '(requires a folder)'
                    : '(none)'
                }
                disabled={draftFolder.trim().length === 0}
              />
              <datalist id={subListId}>
                {subSuggestions.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </label>
          </div>
          <div className="passage-move-actions">
            <button type="submit">Move</button>
            <button type="button" className="ghost" onClick={cancelMove}>
              Cancel
            </button>
          </div>
        </form>
      </li>
    );
  }
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
        className="ghost passage-rename"
        onClick={(e) => {
          e.currentTarget.blur();
          setEditing(true);
        }}
        aria-label={`Rename ${passage.title}`}
        title="Rename"
      >
        ✎
      </button>
      <button
        type="button"
        className="ghost passage-move"
        onClick={(e) => {
          e.currentTarget.blur();
          setMoving(true);
        }}
        aria-label={`Move ${passage.title} to folder`}
        title="Move to folder"
      >
        📁
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

// Above this many words, a paste is probably a book/long work, so offer to
// split it into chapters rather than treat it as one giant passage.
const BOOK_WORD_THRESHOLD = 5000;

function countWords(text: string): number {
  const t = text.trim();
  return t.length === 0 ? 0 : t.split(/\s+/).length;
}

export function PasteView({ state, dispatch }: ViewProps) {
  const [lyricsMode, setLyricsMode] = useState(false);
  // When set, the "Add as book" confirmation modal is open with these chapters
  // and an editable book title.
  const [bookDraft, setBookDraft] = useState<{
    chapters: ReadonlyArray<ChapterSplit>;
    title: string;
  } | null>(null);
  const canStart = state.ui.draftText.trim().length > 0;
  const chunkingMode = lyricsMode ? 'lyrics' : 'prose';
  // Books are prose only — lyrics chunking doesn't make sense for a long work.
  const canAddBook = !lyricsMode && countWords(state.ui.draftText) > BOOK_WORD_THRESHOLD;
  function onStart() {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const passage = buildEmptyPassage(state.ui.draftText, { chunkingMode });
    if (passage === null) return;
    dispatch({ kind: 'start-passage', passage });
  }
  function onSave() {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const passage = buildEmptyPassage(state.ui.draftText, { chunkingMode });
    if (passage === null) return;
    dispatch({ kind: 'save-passage', passage });
  }
  function onAddBookClick() {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const chapters = splitBookIntoChapters(state.ui.draftText);
    if (chapters.length === 0) return;
    const firstLine =
      state.ui.draftText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0) ?? 'Book';
    setBookDraft({ chapters, title: firstLine.slice(0, 50) });
  }
  function onConfirmBook() {
    if (bookDraft === null) return;
    const title = bookDraft.title.trim() || 'Book';
    const passages = bookDraft.chapters
      .map((ch) => buildEmptyPassage(ch.content, { folder: title, title: ch.title }))
      .filter((p): p is Passage => p !== null);
    setBookDraft(null);
    if (passages.length === 0) return;
    dispatch({ kind: 'add-book', passages });
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
        placeholder={lyricsMode ? 'Pega las letras aquí…' : 'Pega aquí…'}
        rows={12}
        spellCheck={false}
        lang="es"
      />
      <label className="paste-lyrics-toggle">
        <input
          type="checkbox"
          checked={lyricsMode}
          onChange={(e) => setLyricsMode(e.target.checked)}
        />
        <span>Song lyrics (split by line, keep stanza breaks)</span>
      </label>
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
        {canAddBook && (
          <button
            type="button"
            className="ghost"
            onClick={onAddBookClick}
            title="Split this long text into chapters and save it as a book"
          >
            Add as book
          </button>
        )}
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
      {bookDraft !== null && (
        <div className="modal-backdrop" onClick={() => setBookDraft(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Add as book"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="modal-header">
              <h2>Add as book</h2>
              <button
                type="button"
                className="modal-close"
                onClick={() => setBookDraft(null)}
                aria-label="Cancel"
              >
                ×
              </button>
            </header>
            <p>
              Detected <strong>{bookDraft.chapters.length}</strong>{' '}
              {bookDraft.chapters.length === 1 ? 'chapter' : 'chapters'}. Save as a
              book?
            </p>
            <label className="voice-select">
              <span>Book title</span>
              <input
                type="text"
                value={bookDraft.title}
                onChange={(e) =>
                  setBookDraft((d) => (d === null ? d : { ...d, title: e.target.value }))
                }
                spellCheck={false}
                autoFocus
              />
            </label>
            <div className="actions">
              <button
                type="button"
                disabled={bookDraft.title.trim().length === 0}
                onClick={onConfirmBook}
              >
                Save book
              </button>
              <button type="button" className="ghost" onClick={() => setBookDraft(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
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
  const {
    currentPassageId,
    listeningHiddenSpanishDone,
    spanishTtsDone,
    englishTtsDone,
    reReadDone,
    englishRevealed,
    readingSpeaking,
    isPaused,
  } = state.ui;
  const readingMode = state.learner.settings.readingMode;
  // Keep the existing scaffolded/listening effect tree unchanged: 'listening'
  // is the only mode with the hidden-Spanish phase, and in 'light' mode this is
  // false so the Spanish phase plays once with text visible.
  const listeningMode = readingMode === 'listening';
  const lightMode = readingMode === 'light';
  // 'reading' mode: text-first, fully manual, silent until Continue. Its Spanish
  // audio only ever plays during the SPEAKING phase (readingSpeaking), and only
  // when readAloudOnAdvance is on.
  const textMode = readingMode === 'reading';
  const readAloudOnAdvance = state.learner.settings.readAloudOnAdvance;
  const speechPaceMultiplier = state.learner.settings.speechPaceMultiplier;
  const readPaceMultiplier = state.learner.settings.readPaceMultiplier;
  const englishTtsEnabled = state.learner.settings.englishTtsEnabled;
  const englishSpeechPaceMultiplier = state.learner.settings.englishSpeechPaceMultiplier;
  const reReadEnabled = state.learner.settings.reReadEnabled;
  const reReadPaceMultiplier = state.learner.settings.reReadPaceMultiplier;
  const reReadAlternates = state.learner.settings.reReadAlternates;
  const reReadShortChunks = state.learner.settings.reReadShortChunks;
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

  // In a book-like folder, finishing a chapter offers a jump straight to the
  // next one. Gated on isBookLikeFolder so a generic folder of numbered
  // articles never auto-advances (findNextChapter alone would happily chain
  // "Article 1" → "Article 2"). null outside books and on the last chapter.
  const allPassages = state.learner.passages;
  const nextChapter = useMemo(() => {
    if (passage?.folder == null || currentPassageId === null) return null;
    const siblings = Object.values(allPassages).filter(
      (p) => p.folder === passage.folder && p.subfolder === passage.subfolder,
    );
    if (!isBookLikeFolder(siblings)) return null;
    return findNextChapter(siblings, currentPassageId);
  }, [allPassages, passage?.folder, passage?.subfolder, currentPassageId]);
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

  // Will the re-read effect actually fire for this chunk? Same condition
  // as the effect uses, so the highlight logic stays in sync. When re-read
  // is suppressed (short chunk, placeholder, etc.), the highlight stays on
  // English after the English phase — no flash back to Spanish.
  const reReadWillFireForThisChunk =
    reReadEnabled &&
    !isPlaceholderChunk &&
    currentChunk !== undefined &&
    (reReadShortChunks ||
      countSignificantWords(currentChunk.tlText, currentChunk.englishGloss) > 3);

  // Visual emphasis follows the audio. With re-read on, the highlight stays
  // on the Spanish cell from the start of re-read all the way through hold
  // and advance — so the eye moves straight down into the next chunk's
  // Spanish cell instead of flashing back to English first.
  let activeSide: 'tl' | 'en';
  if (textMode) {
    // Reading mode: no audio gates the highlight — it sits on Spanish while the
    // reader works, moving to English only once they've revealed the gloss.
    activeSide = englishRevealed ? 'en' : 'tl';
  } else if (lightMode) {
    // Light mode: the highlight stays on Spanish while the reader decides,
    // moving to English only once they've revealed it.
    activeSide = spanishTtsDone && englishRevealed ? 'en' : 'tl';
  } else if (!spanishTtsDone) {
    activeSide = 'tl';
  } else if (englishTtsEnabled && !englishTtsDone) {
    activeSide = 'en';
  } else if (reReadWillFireForThisChunk) {
    activeSide = 'tl';
  } else {
    activeSide = 'en';
  }

  // Whether the CURRENT chunk's English gloss is visible. Past chunks always
  // show it (handled in SentenceItem). The three audio-driven modes reveal it
  // once Spanish TTS has played (light additionally gates on a Show English
  // tap); reading mode is silent, so it keys purely on the Show English toggle.
  const showCurrentGloss = textMode
    ? englishRevealed
    : lightMode
      ? spanishTtsDone && englishRevealed
      : spanishTtsDone;

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
  const hiddenSpanishSpeechRef = useRef<SpeechController | null>(null);
  const spanishSpeechRef = useRef<SpeechController | null>(null);
  const englishSpeechRef = useRef<SpeechController | null>(null);
  const reReadSpeechRef = useRef<SpeechController | null>(null);

  // Cancel any in-flight utterance when the current chunk changes (or the
  // view unmounts). Runs BEFORE the phase-driver effects start the next
  // chunk's speech. We have to cancel all four because we may have been
  // paused at any phase when the user clicked advance.
  useEffect(() => {
    return () => {
      const refs = [
        hiddenSpanishSpeechRef,
        spanishSpeechRef,
        englishSpeechRef,
        reReadSpeechRef,
      ];
      for (const r of refs) {
        if (r.current && !r.current.isEnded()) {
          r.current.cancel();
        }
        r.current = null;
      }
    };
  }, [currentChunk?.id]);

  // Scroll the active row (or the end-of-passage message) into view. `block`
  // tunes how aggressive that is:
  //   'nearest' — minimum scroll; a row that's already visible is left alone.
  //   'center'  — deliberately re-center the row.
  const scrollActiveIntoView = useCallback(
    (block: ScrollLogicalPosition) => {
      const root = sentencesRef.current;
      if (!root) return;
      const target = isDone
        ? root.parentElement?.querySelector('.done')
        : root.querySelector('.pair-row.current');
      if (target instanceof HTMLElement) {
        target.scrollIntoView({ behavior: 'smooth', block });
      }
    },
    [isDone],
  );

  // Gentle follow while reading. Advancing to a new chunk — or the English
  // gloss appearing, which grows the row — nudges the row into view ONLY if
  // part of it is off-screen. 'nearest' (not 'center') means a visible row is
  // never yanked around: the view stays put so the reader can tap a word, and
  // nothing scrolls out of reach or reserves empty space prematurely.
  useEffect(() => {
    scrollActiveIntoView('nearest');
  }, [currentChunkIndex, spanishTtsDone, scrollActiveIntoView]);

  // Deliberate re-orientation: re-center the active row right after the reader
  // resumes, OR after a word-lookup / grammar panel closes — including a close
  // while still paused, so the text returns to its reading position and clears
  // the fixed "Paused" pill instead of staying where the lookup scrolled it.
  // Refs detect the resume/close transitions so we DON'T re-center on the
  // opposite events (pausing, or opening a panel — which scrolls itself).
  const wasPausedRef = useRef(isPaused);
  const hadPanelOpenRef = useRef(false);
  useEffect(() => {
    const panelOpen = state.ui.wordLookup !== null || state.ui.grammarPanel !== null;
    const justResumed = wasPausedRef.current && !isPaused;
    const justClosedPanel = hadPanelOpenRef.current && !panelOpen;
    wasPausedRef.current = isPaused;
    hadPanelOpenRef.current = panelOpen;
    if (justResumed || justClosedPanel) {
      scrollActiveIntoView('center');
    }
  }, [isPaused, state.ui.wordLookup, state.ui.grammarPanel, scrollActiveIntoView]);

  // Listening-mode hidden Spanish phase: in listeningMode, the first audio
  // play happens with all text hidden. Once it ends, listeningHiddenSpanishDone
  // flips true and the regular Spanish effect (with text now visible) fires.
  useEffect(() => {
    if (!currentChunk) return;
    if (!listeningMode) return;
    if (listeningHiddenSpanishDone) return;

    if (settingsOpen || isPaused) {
      if (
        hiddenSpanishSpeechRef.current &&
        !hiddenSpanishSpeechRef.current.isEnded()
      ) {
        hiddenSpanishSpeechRef.current.cancel();
      }
      hiddenSpanishSpeechRef.current = null;
      return;
    }

    if (isPlaceholderChunk) {
      dispatch({
        kind: 'listening-hidden-spanish-finished',
        chunkId: currentChunk.id,
      });
      return;
    }

    if (hiddenSpanishSpeechRef.current) {
      hiddenSpanishSpeechRef.current.cancel();
      hiddenSpanishSpeechRef.current = null;
    }

    const chunkAtStart = currentChunk;
    const ttsRate = 0.85 * speechPaceMultiplier;
    hiddenSpanishSpeechRef.current = speakChunk(
      currentChunk.tlText,
      firstVoice,
      ttsRate,
      speechPaceMultiplier,
      () =>
        dispatch({
          kind: 'listening-hidden-spanish-finished',
          chunkId: chunkAtStart.id,
        }),
    );
  }, [
    currentChunk?.id,
    listeningMode,
    listeningHiddenSpanishDone,
    isPaused,
    settingsOpen,
    isPlaceholderChunk,
    speechPaceMultiplier,
    firstVoice,
    dispatch,
  ]);

  // Speak the Spanish chunk when it becomes current (or on replay). Pause
  // stops the utterance mid-word. On resume we re-speak the chunk from the
  // beginning rather than calling synth.resume() — Chrome's resume()
  // silently fails after a few seconds paused, which produced the "pressed
  // resume but nothing happens" bug. Re-speaking is reliable; the cost is
  // re-hearing whatever you already heard of the current chunk.
  useEffect(() => {
    if (!currentChunk) return;
    if (spanishTtsDone) return;
    // In listening mode, wait for the hidden Spanish phase to complete
    // before firing the visible-text Spanish phase.
    if (listeningMode && !listeningHiddenSpanishDone) return;
    // Reading mode is silent in the READING state — the Spanish audio only
    // plays during the SPEAKING phase (after Continue, with readAloudOnAdvance
    // on). Until then, never start an utterance.
    if (textMode && !readingSpeaking) return;

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
    listeningMode,
    listeningHiddenSpanishDone,
    textMode,
    readingSpeaking,
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
    // Reading mode never reads the English gloss aloud — it's a text-only,
    // on-demand reveal. The only audio this mode has is the Spanish at advance.
    if (textMode) return;
    if (!spanishTtsDone) return;
    if (englishTtsDone) return;
    if (!englishTtsEnabled) return;
    // Light mode gates English behind a deliberate "Show English" tap.
    if (lightMode && !englishRevealed) return;

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
    lightMode,
    textMode,
    englishRevealed,
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
    // Light and reading modes never re-read — the reader controls repetition via
    // Replay.
    if (lightMode || textMode) return;
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

    // Skip re-read for very short chunks (≤3 significant new words). The
    // pedagogical value of a second reading is low for "Howard Jones." or
    // "Hola." — and the dead-air feels worse than useful. Setting overrides.
    if (
      !reReadShortChunks &&
      countSignificantWords(currentChunk.tlText, currentChunk.englishGloss) <= 3
    ) {
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
    lightMode,
    textMode,
    reReadEnabled,
    reReadShortChunks,
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

  // Light mode: Spanish is done and we're parked, waiting on the reader. The
  // two-button bar shows; nothing advances until the reader taps Continue (or
  // Show English). Light mode never auto-advances — the reader always drives.
  const lightAwaitingInput = lightMode && spanishTtsDone && !isPaused;

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

    // Light AND reading modes never auto-advance: the reader always drives,
    // tapping Continue. No timer is ever started here. (Reading mode's
    // SPEAKING → advance is handled by its own audio-end effect, not a timer.)
    if (lightMode || textMode) return;

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
    lightMode,
    textMode,
    isPaused,
    settingsOpen,
    readPaceMultiplier,
    englishTtsEnabled,
    dispatch,
  ]);

  // Reading mode SPEAKING → advance. After Continue (with readAloudOnAdvance on)
  // the chunk's Spanish plays once; when it ends (spanishTtsDone flips true) we
  // advance to the next chunk. This is NOT a timer-based auto-advance — it's the
  // direct, intended consequence of the reader's Continue tap. Skipping the
  // audio mid-play is handled separately by the 'reading-continue' reducer.
  useEffect(() => {
    if (!textMode) return;
    if (!readingSpeaking) return;
    if (!spanishTtsDone) return;
    if (isPaused || settingsOpen) return;
    dispatch({ kind: 'advance' });
  }, [
    textMode,
    readingSpeaking,
    spanishTtsDone,
    isPaused,
    settingsOpen,
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
        // Reading mode: Space is always Continue (the mode never has playing
        // audio to pause in the READING state, and during SPEAKING Continue
        // means "skip + advance").
        if (textMode) {
          dispatch({ kind: 'reading-continue' });
        } else if (lightMode && lightAwaitingInput) {
          // Light mode: once parked awaiting input, Space means Continue. While
          // Spanish audio is still playing (not yet parked), Space still pauses.
          dispatch({ kind: 'advance' });
        } else {
          dispatch({ kind: 'toggle-pause' });
        }
      } else if ((e.key === 'e' || e.key === 'E') && textMode) {
        // Reading mode: E toggles the gloss on/off.
        e.preventDefault();
        dispatch({ kind: 'toggle-reading-english' });
      } else if (
        (e.key === 'e' || e.key === 'E') &&
        lightMode &&
        lightAwaitingInput &&
        !englishRevealed
      ) {
        e.preventDefault();
        dispatch({ kind: 'reveal-english' });
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
  }, [dispatch, lightMode, textMode, lightAwaitingInput, englishRevealed]);

  if (!passage) {
    return <ErrorView dispatch={dispatch} message="No passage loaded." />;
  }

  return (
    <main className="container reading-container">
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

      {/* Inner scroll container sized to the dynamic (actually-visible)
          viewport via .reading-container, so the active-line auto-scroll
          centers against what's visible — not the larger layout viewport
          whose extra height (the mobile browser's dynamic toolbar) used to
          push the line's lower half off the bottom of the screen. */}
      <div
        className="reading-scroll"
        onClick={(e) => {
          // The dimmed area behind an open lookup/grammar sheet is non-blocking
          // (pointer-events: none), so taps reach words + controls. Tapping
          // empty space here still dismisses the open panel; taps on a word, the
          // grammar button, the panel, or the light action bar are left to their
          // own handlers (which switch / act instead of dismissing).
          const target = e.target as HTMLElement;
          const onInteractive = target.closest(
            '.word-clickable, .grammar-button, .word-lookup-panel, .grammar-panel, .light-action-bar',
          );
          if (state.ui.wordLookup === null && state.ui.grammarPanel === null) return;
          if (onInteractive) return;
          if (state.ui.wordLookup !== null) dispatch({ kind: 'dismiss-lookup' });
          if (state.ui.grammarPanel !== null) dispatch({ kind: 'dismiss-grammar' });
        }}
      >
      <ol
        className={
          'sentences' +
          (state.ui.wordLookup || state.ui.grammarPanel ? ' lookup-open' : '')
        }
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
              activeSide={activeSide}
              isFading={isFading}
              wordLookup={state.ui.wordLookup}
              grammarPanel={state.ui.grammarPanel}
              hideCurrentChunkText={
                listeningMode && !listeningHiddenSpanishDone
              }
              showCurrentGloss={showCurrentGloss}
              dispatch={dispatch}
            />
          ))}
      </ol>

      {isDone && (
        <div className="done">
          <p>{nextChapter ? 'Done with this chapter.' : 'Done with this passage.'}</p>
          <div className="done-actions">
            {nextChapter && (
              <button
                type="button"
                className="next-chapter-btn"
                onClick={(e) => {
                  e.currentTarget.blur();
                  dispatch({
                    kind: 'open-passage',
                    passageId: nextChapter.id,
                    now: Date.now(),
                  });
                }}
              >
                Continue to {nextChapter.title} →
              </button>
            )}
            <button
              type="button"
              className="ghost"
              onClick={(e) => {
                e.currentTarget.blur();
                dispatch({ kind: 'go-to-library' });
              }}
            >
              Back to library
            </button>
          </div>
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

      {/* Scroll runway inside .reading-scroll: the active line is always the
          LAST rendered line (the list is filtered to index <=
          currentChunkIndex), so without space beneath it scrollIntoView
          ({block:'center'}) has nothing to scroll into. This lets the active
          line reach the middle of the visible scroll area on every chunk. */}
      <div className="reading-runway" aria-hidden="true" />
      </div>

      {/* Light mode: once the chunk's Spanish audio has played, park here with a
          two-button bar. Nothing advances on its own — the reader taps Show
          English to see the gloss, then Continue (or Space) to move on. */}
      {lightMode &&
        spanishTtsDone &&
        !isDone &&
        state.ui.wordLookup === null &&
        state.ui.grammarPanel === null &&
        !settingsOpen && (
          <div className="light-action-bar">
            <div className="light-buttons">
              {!englishRevealed && (
                <button
                  type="button"
                  className="light-btn light-btn-secondary"
                  onClick={(e) => {
                    e.currentTarget.blur();
                    dispatch({ kind: 'reveal-english' });
                  }}
                >
                  Show English
                </button>
              )}
              <button
                type="button"
                className="light-btn light-btn-primary"
                onClick={(e) => {
                  e.currentTarget.blur();
                  dispatch({ kind: 'advance' });
                }}
              >
                Continue
              </button>
            </div>
          </div>
        )}

      {/* Reading mode: a persistent two-button bar (Show/Hide English +
          Continue). Unlike light mode it's shown the whole time — there's no
          audio phase to wait for, and during SPEAKING Continue must stay
          tappable so the reader can skip the audio. Larger tap targets
          (.reading-action-bar) for tablet use mid-exercise. */}
      {textMode &&
        !isDone &&
        state.ui.wordLookup === null &&
        state.ui.grammarPanel === null &&
        !settingsOpen && (
          <div className="light-action-bar reading-action-bar">
            <div className="light-buttons">
              <button
                type="button"
                className="light-btn light-btn-secondary"
                onClick={(e) => {
                  e.currentTarget.blur();
                  dispatch({ kind: 'toggle-reading-english' });
                }}
              >
                {englishRevealed ? 'Hide English' : 'Show English'}
              </button>
              <button
                type="button"
                className="light-btn light-btn-primary"
                onClick={(e) => {
                  e.currentTarget.blur();
                  dispatch({ kind: 'reading-continue' });
                }}
              >
                Continue
              </button>
            </div>
          </div>
        )}

      {/* Resume affordance. Fixed to the bottom of the screen (outside the
          scroller) so it's always fully visible and easy to tap — the reader's
          instinct is to tap the "Paused" text to continue. Shown only for a
          deliberate pause: a word-lookup / grammar panel also sets isPaused but
          has its own bottom sheet, so suppress the badge then (and under the
          settings modal). In light mode the action bar above is the resume
          affordance once Spanish has played, so suppress the badge then too. */}
      {isPaused &&
        !(lightMode && spanishTtsDone) &&
        !textMode &&
        state.ui.wordLookup === null &&
        state.ui.grammarPanel === null &&
        !settingsOpen && (
          <button
            type="button"
            className="paused-badge"
            onClick={(e) => {
              e.currentTarget.blur();
              dispatch({ kind: 'toggle-pause' });
            }}
            title="Resume from where you paused"
          >
            Paused — tap to resume
          </button>
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
  readonly activeSide: 'tl' | 'en';
  readonly isFading: boolean;
  readonly wordLookup: WordLookupUiState | null;
  readonly grammarPanel: GrammarPanelUiState | null;
  // Listening-mode phase 1: hide the Spanish (and English) text for the
  // current chunk only. The user listens without seeing the words. Past
  // sentences stay fully visible.
  readonly hideCurrentChunkText: boolean;
  // Whether the CURRENT chunk's English gloss should be shown. Past sub-chunks
  // always show their gloss; this only gates the actively-read chunk. Computed
  // in ReadingView per mode (audio-done, light's Show-English gate, or reading
  // mode's Show-English toggle).
  readonly showCurrentGloss: boolean;
  readonly dispatch: (a: AppAction) => void;
}

function SentenceItem({
  sentence,
  currentChunkIndex,
  activeSide,
  isFading,
  wordLookup,
  grammarPanel,
  hideCurrentChunkText,
  showCurrentGloss,
  dispatch,
}: SentenceItemProps) {
  const hasCurrent = sentence.some((c) => c.index === currentChunkIndex);
  const lookupInThisSentence =
    wordLookup !== null && sentence.some((c) => c.id === wordLookup.chunkId);
  const grammarInThisSentence =
    grammarPanel !== null && sentence.some((c) => c.id === grammarPanel.chunkId);
  // Lyrics mode: the first sub-chunk of a line that follows a blank line in
  // the source carries precededByBlankLine. The render then adds extra top
  // spacing so stanzas read as stanzas, not as a wall of text.
  const stanzaBreak = sentence[0]?.precededByBlankLine === true;

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
      <li className={'sentence past' + (stanzaBreak ? ' stanza-break' : '')}>
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
        {grammarInThisSentence && grammarPanel && (
          <GrammarPanel panel={grammarPanel} dispatch={dispatch} />
        )}
      </li>
    );
  }

  // Current sentence: paired rows so each chunk's Spanish sits next to its
  // English. The active row is emphasized; past rows of this same sentence
  // remain visible (dimmer) for in-sentence context.
  const visibleSubChunks = sentence.filter((c) => c.index <= currentChunkIndex);

  return (
    <li className={'sentence current' + (stanzaBreak ? ' stanza-break' : '')}>
      <div className="pairs">
        {visibleSubChunks.map((c) => {
          const isCurrentSub = c.index === currentChunkIndex;
          // Listening-mode phase 1: hide Spanish AND English for the current
          // sub-chunk. Past sub-chunks of this sentence remain visible — the
          // hide only applies to the actively-listening chunk.
          const hideForListening = isCurrentSub && hideCurrentChunkText;
          const showGloss =
            !isCurrentSub || (showCurrentGloss && c.englishGloss !== null);
          let rowCls = isCurrentSub ? 'pair-row current' : 'pair-row past';
          if (isCurrentSub) {
            // Emphasis follows the audio through the playback sequence.
            rowCls += activeSide === 'tl' ? ' tl-active' : ' en-active';
          }
          if (isCurrentSub && isFading) rowCls += ' fading';
          if (hideForListening) rowCls += ' listening-hidden';
          return (
            <div key={c.id} className={rowCls}>
              <div className="pair-tl">
                {hideForListening ? (
                  <span className="listening-placeholder" aria-hidden="true">
                    🎧 listening…
                  </span>
                ) : (
                  <>
                    <ClickableSpanish
                      text={c.tlText}
                      chunkId={c.id}
                      dispatch={dispatch}
                    />
                    <button
                      type="button"
                      className="grammar-button"
                      onClick={(e) => {
                        e.currentTarget.blur();
                        dispatch({ kind: 'request-grammar', chunkId: c.id });
                      }}
                      aria-label="Explain grammar of this chunk"
                      title="Explain grammar"
                    >
                      ¶
                    </button>
                  </>
                )}
              </div>
              <div className="pair-en">
                {hideForListening ? '' : showGloss ? c.englishGloss : ''}
              </div>
            </div>
          );
        })}
      </div>
      {lookupInThisSentence && wordLookup && (
        <WordLookupPanel lookup={wordLookup} dispatch={dispatch} />
      )}
      {grammarInThisSentence && grammarPanel && (
        <GrammarPanel panel={grammarPanel} dispatch={dispatch} />
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
  ready,
}: {
  voice: SpeechSynthesisVoice | null;
  spanishVoiceCount: number;
  allVoices: ReadonlyArray<SpeechSynthesisVoice>;
  ready: boolean;
}) {
  // Always render as a single inline line. The old prominent warning panel
  // (with the "show installed voices" details expander) was redundant — the
  // user can see the same info in the Spanish voice dropdown right below.
  if (!ready) {
    return <span className="voice-indicator">🔊 Looking for voices…</span>;
  }
  if (voice === null && spanishVoiceCount === 0) {
    return (
      <span className="voice-indicator">
        🔊 No Spanish voice installed on this device
      </span>
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
  // panel is already visible. On mobile the panel is a fixed bottom sheet,
  // so scrolling the panel itself does nothing — instead, scroll the parent
  // sentence above the sheet so the looked-up word stays visible.
  useEffect(() => {
    if (window.matchMedia('(min-width: 641px)').matches) {
      panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      panelRef.current?.parentElement?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    }
  }, [lookup.kind]);
  return (
    <>
      <div className="word-lookup-backdrop" aria-hidden="true" />
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
    </>
  );
}

function GrammarPanel({
  panel,
  dispatch,
}: {
  panel: GrammarPanelUiState;
  dispatch: (a: AppAction) => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Mirror the word-lookup behavior: on desktop scroll the panel itself into
  // view; on mobile the panel is a fixed bottom sheet, so scroll the parent
  // sentence above the sheet instead.
  useEffect(() => {
    if (window.matchMedia('(min-width: 641px)').matches) {
      panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      panelRef.current?.parentElement?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    }
  }, [panel.kind]);
  return (
    <>
      <div className="grammar-backdrop" aria-hidden="true" />
      <div
        ref={panelRef}
        className={`grammar-panel kind-${panel.kind}`}
        role="dialog"
        aria-label="Grammar explanation"
      >
        <div className="lookup-header">
          <span className="lookup-word">Grammar</span>
          <button
            type="button"
            className="lookup-dismiss"
            onClick={(e) => {
              e.currentTarget.blur();
              dispatch({ kind: 'dismiss-grammar' });
            }}
            aria-label="Close grammar panel"
            title="Close (audio stays paused — hit Resume to continue)"
          >
            ×
          </button>
        </div>
        {panel.kind === 'loading' && (
          <div className="lookup-body lookup-loading">Looking up…</div>
        )}
        {panel.kind === 'error' && (
          <div className="lookup-body lookup-error">{panel.message}</div>
        )}
        {panel.kind === 'ready' && panel.explanation.isUnremarkable && (
          <div className="lookup-body grammar-unremarkable">
            Nothing notable in this sentence.
          </div>
        )}
        {panel.kind === 'ready' && !panel.explanation.isUnremarkable && (
          <div className="lookup-body">
            {panel.explanation.summary.length > 0 && (
              <p className="grammar-summary">{panel.explanation.summary}</p>
            )}
            {panel.explanation.notes.length > 0 && (
              <ul className="grammar-notes">
                {panel.explanation.notes.map((note, i) => (
                  <li key={i}>
                    <strong>{note.topic}:</strong> {note.explanation}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </>
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
