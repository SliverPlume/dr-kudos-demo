import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEVICE_ID, requestGraphQL, onConnectionChange, chatOperations, subscribe, type Conversation, type Message } from './api';

import { MessageStatus } from './MessageStatus';
import { useMessageViewport } from './useMessageViewport';

import { mergeMessage, mergePage, mergeReceipt, type Thread, type UiMessage } from './thread';

type Visit = { date: string; treatment: string; clinician: string };
const MAX_MESSAGE_LENGTH = 2000;

const useLocalStorage = (key: string, initial: string, migrate?: (value: string) => string) => {
  const [value, setValue] = useState(() => {
    const saved = localStorage.getItem(key) ?? initial;
    return migrate ? migrate(saved) : saved;
  });
  useEffect(() => localStorage.setItem(key, value), [key, value]);
  return [value, setValue] as const;
};

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const shortDate = (iso: string) => {
  const date = new Date(iso);
  return date.toDateString() === new Date().toDateString()
    ? time(iso)
    : date.toLocaleDateString([], { day: 'numeric', month: 'short' });
};
const initials = (name: string) => name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase();

function PatientSummary({ conversation }: { conversation: Conversation }) {
  const [visit, setVisit] = useState<Visit | null>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    requestGraphQL<{ conversation: { latestVisit: Visit | null } | null }>(chatOperations.latestVisit, { id: conversation.id })
      .then(({ conversation }) => { if (active) setVisit(conversation?.latestVisit ?? null); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [conversation.id]);
  return (
    <section className="card">
      <h3>Patient summary</h3>
      <div className="patient-identity">
        <span className="avatar lg">{initials(conversation.patientName)}</span>
        <strong>{conversation.patientName}</strong>
      </div>
      {visit ? <dl>
        <dt>Last visit</dt><dd>{visit.treatment} · {visit.date}</dd>
        <dt>Clinician</dt><dd>{visit.clinician}</dd>
      </dl> : <p className="muted small" role="status">
        {failed ? 'Could not load visit details.' : visit === null ? 'No visits recorded.' : 'Loading visit details…'}
      </p>}
    </section>
  );
}

export function App() {
  const [conversationsById, setConversationsById] = useState<Record<string, Conversation>>({});
  const [threadsByConversation, setThreadsByConversation] = useState<Record<string, Thread>>({});
  const [selectedConversationId, setSelectedConversationId] = useState<string>('conv-chloe');
  const [languages, setLanguages] = useState<{ code: string; label: string }[]>([]);
  const [targetLanguage, setTargetLanguage] = useLocalStorage('dk.lang', 'zh', (saved) => {
    if (saved === 'zh-Hant') return 'zh';
    if (saved === 'zh-Hans') return 'cn';
    return saved;
  });
  const [staffName, setStaffName] = useLocalStorage('dk.staff', 'Amy Wong');
  const [connected, setConnected] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<'inbox' | 'details' | null>(null);
  const [changingModes, setChangingModes] = useState<Record<string, boolean>>({});
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [translatingCount, setTranslatingCount] = useState(0);
  const threadsRef = useRef(threadsByConversation);
  threadsRef.current = threadsByConversation;
  const languageRef = useRef(targetLanguage);
  languageRef.current = targetLanguage;

  const conversation = conversationsById[selectedConversationId];
  const thread = threadsByConversation[selectedConversationId];
  const draft = drafts[selectedConversationId] ?? '';

  const overLimit = draft.trim().length > MAX_MESSAGE_LENGTH;
  const changingMode = !!changingModes[selectedConversationId];

  const loadConversations = useCallback(async () => {
    const { conversations } = await requestGraphQL<{ conversations: Conversation[] }>(chatOperations.conversations);
    setConversationsById(Object.fromEntries(conversations.map((conversation) => [conversation.id, conversation])));
  }, []);

  const loadThread = useCallback(
    async (conversationId: string) => {
      setTranslatingCount((count) => count + 1);
      try {
        let oldestLoaded = threadsRef.current[conversationId]?.oldestSeq;
        // Render message bubbles immediately on first open before awaiting AI translations.
        if (!threadsRef.current[conversationId]) {
          const core = await requestGraphQL<{ messages: { items: Message[]; hasMore: boolean } }>(
            chatOperations.messagesCore,
            { conversationId },
          );
          oldestLoaded = core.messages.items[0]?.seq;
          setThreadsByConversation((currentThreads) =>
            currentThreads[conversationId]
              ? currentThreads
              : {
                  ...currentThreads,
                  [conversationId]: mergePage(undefined, core.messages.items, oldestLoaded, core.messages.hasMore),
                },
          );
        }

        let before: number | undefined;
        let hasMore = true;
        const items: Message[] = [];
        // Re-fetch through the oldest loaded cursor: fills reconnect gaps and
        // translates all loaded history when the language changes.
        do {
          const page = await requestGraphQL<{ messages: { items: Message[]; hasMore: boolean } }>(chatOperations.messages, {
            conversationId,
            lang: targetLanguage,
            before,
          });
          if (languageRef.current !== targetLanguage) return;
          items.push(...page.messages.items);
          hasMore = page.messages.hasMore;
          before = page.messages.items[0]?.seq;
        } while (hasMore && before != null && oldestLoaded != null && before > oldestLoaded);
        setThreadsByConversation((currentThreads) => ({
          ...currentThreads,
          [conversationId]: mergePage(currentThreads[conversationId], items, before, hasMore),
        }));
        setError(null);
      } finally {
        setTranslatingCount((count) => Math.max(0, count - 1));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [targetLanguage],
  );

  const loadOlder = async () => {
    if (!thread?.hasMore || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const { messages } = await requestGraphQL<{ messages: { items: Message[]; hasMore: boolean } }>(chatOperations.messages, {
        conversationId: selectedConversationId,
        lang: targetLanguage,
        before: thread.oldestSeq,
      });
      if (languageRef.current !== targetLanguage) return;
      setThreadsByConversation((currentThreads) => ({
        ...currentThreads,
        [selectedConversationId]: mergePage(currentThreads[selectedConversationId], messages.items,
          messages.items[0]?.seq ?? thread.oldestSeq, messages.hasMore),
      }));
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setLoadingOlder(false);
    }
  };

  useEffect(() => {
    requestGraphQL<{ languages: { code: string; label: string }[] }>(chatOperations.languages)
      .then((data) => setLanguages(data.languages))
      .catch(() => setError('Could not load translation languages'));
    loadConversations().catch(() => setError('Cannot reach the server on :4000'));
  }, [loadConversations]);

  useEffect(() => {
    loadThread(selectedConversationId).catch((error) => setError(error.message));
  }, [selectedConversationId, loadThread]);

  useEffect(() => {
    const unsubscribeCallbacks = [
      subscribe<{ onMessageAdded: Message }>(chatOperations.onMessageAdded, { lang: targetLanguage }, ({ onMessageAdded: message }) => {
        setConversationsById((currentConversations) =>
          currentConversations[message.conversationId]
            ? {
                ...currentConversations,
                [message.conversationId]: {
                  ...currentConversations[message.conversationId],
                  lastMessage: message,
                  updatedAt: message.createdAt,
                },
              }
            : currentConversations,
        );
        setThreadsByConversation((currentThreads) =>
          currentThreads[message.conversationId]
            ? {
                ...currentThreads,
                [message.conversationId]: {
                  ...currentThreads[message.conversationId],
                  items: mergeMessage(currentThreads[message.conversationId].items, message),
                },
              }
            : currentThreads,
        );
        if (message.sender === 'PATIENT' && threadsRef.current[message.conversationId]) {
          loadThread(message.conversationId).catch((error) => setError(error.message));
        }
      }),
      subscribe<{ onMessageUpdated: Message }>(chatOperations.onMessageUpdated, { lang: targetLanguage }, ({ onMessageUpdated: message }) =>
        setThreadsByConversation((threads) => mergeReceipt(threads, message)),
      ),
      subscribe<{ onConversationUpdated: Conversation }>(chatOperations.onConversationUpdated, {}, ({ onConversationUpdated: conversation }) =>
        setConversationsById((currentConversations) => ({
          ...currentConversations,
          [conversation.id]: conversation,
        })),
      ),
    ];
    return () => unsubscribeCallbacks.forEach((unsubscribe) => unsubscribe());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetLanguage]);

  useEffect(
    () =>
      onConnectionChange((isConnected) => {
        setConnected(isConnected);
        if (isConnected) {
          loadConversations().catch((error) => setError(error.message));
          loadThread(selectedConversationId).catch((error) => setError(error.message));
        }
      }),
    [loadConversations, loadThread, selectedConversationId],
  );

  const changeMode = async () => {
    if (!conversation || changingMode) return;
    const id = conversation.id;
    const operation = conversation.mode === 'AI' ? 'takeOver' : 'handBack';
    setChangingModes((current) => ({ ...current, [id]: true }));
    try {
      type ModeUpdate = Pick<Conversation, 'id' | 'mode' | 'staffName' | 'aiTyping'>;
      const result = await requestGraphQL<Record<string, ModeUpdate>>(chatOperations[operation], { conversationId: id, staff: staffName });
      setConversationsById((current) => ({ ...current, [id]: { ...current[id], ...result[operation] } }));
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setChangingModes((current) => ({ ...current, [id]: false }));
    }
  };

  const send = async (retry?: UiMessage) => {
    const text = retry?.text ?? draft.trim();
    if (!text || text.length > MAX_MESSAGE_LENGTH || conversation?.mode !== 'STAFF' || changingMode || !thread) return;
    const conversationId = selectedConversationId;
    const clientId = retry?.key ?? crypto.randomUUID();
    if (!retry) {
      returnToLatest();
      setDrafts((current) => ({ ...current, [conversationId]: '' }));
    }
    const optimistic: UiMessage = {
      key: clientId,
      id: clientId,
      clientId,
      seq: 0,
      conversationId,
      sender: 'STAFF',
      senderName: retry?.senderName ?? staffName,
      senderDeviceId: DEVICE_ID,
      text,
      createdAt: retry?.createdAt ?? new Date().toISOString(),
      status: 'SENT',
      readAt: null,
      pending: true,
    };
    setThreadsByConversation((currentThreads) => ({
      ...currentThreads,
      [conversationId]: {
        ...currentThreads[conversationId],
        items: mergeMessage(currentThreads[conversationId].items, optimistic, { pending: true }),
      },
    }));
    try {
      const { sendStaffMessage } = await requestGraphQL<{ sendStaffMessage: Message }>(chatOperations.sendStaff, {
        input: { conversationId, clientId, text, deviceId: DEVICE_ID },
        staff: optimistic.senderName,
      });
      setThreadsByConversation((currentThreads) => ({
        ...currentThreads,
        [conversationId]: {
          ...currentThreads[conversationId],
          items: mergeMessage(currentThreads[conversationId].items, sendStaffMessage),
        },
      }));
    } catch (error) {
      setThreadsByConversation((currentThreads) => ({
        ...currentThreads,
        [conversationId]: {
          ...currentThreads[conversationId],
          items: currentThreads[conversationId].items.map((message) =>
            message.key === clientId && message.pending ? { ...message, pending: false, failed: true } : message,
          ),
        },
      }));
      setError((error as Error).message);
    }
  };

  const applyReadReceipts = useCallback((messages: Message[]) => {
    setThreadsByConversation((threads) => messages.reduce(mergeReceipt, threads));
  }, []);
  const { containerRef, checkViewport, returnToLatest, showScrollButton } = useMessageViewport(
    selectedConversationId, thread?.items, conversation?.aiTyping, connected, targetLanguage, applyReadReceipts,
  );

  const sortedConversations = useMemo(
    () => Object.values(conversationsById).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [conversationsById],
  );
  const languageLabel = languages.find((language) => language.code === targetLanguage)?.label ?? targetLanguage;

  return (
    <div className="app" data-panel={panel}>
      <nav className="panel-switch" aria-label="Conversation panels">
        <button type="button" aria-controls="inbox" aria-expanded={panel === 'inbox'}
          onClick={() => setPanel(panel === 'inbox' ? null : 'inbox')}>Patients</button>
        <button type="button" aria-controls="details" aria-expanded={panel === 'details'}
          onClick={() => setPanel(panel === 'details' ? null : 'details')}>Details</button>
      </nav>
      <aside className="sidebar" id="inbox">
        <div className="brand">
          <span className="logo">DK</span>
          <div>
            <div className="brand-name">Dr. Kudos Lab</div>
            <div className="brand-sub">Clinic inbox</div>
          </div>
        </div>
        <div className={`conn ${connected ? 'ok' : ''}`}>
          <span className="dot" /> {connected ? 'Live · realtime channel connected' : 'Reconnecting…'}
        </div>
        <nav className="conv-list">
          {sortedConversations.map((conversation) => (
            <button
              key={conversation.id}
              className={`conv ${conversation.id === selectedConversationId ? 'active' : ''}`}
              onClick={() => { setSelectedConversationId(conversation.id); setPanel(null); }}
            >
              <span className="avatar">{initials(conversation.patientName)}</span>
              <span className="conv-body">
                <span className="conv-top">
                  <span className="conv-name">{conversation.patientName}</span>
                  <span className="conv-time">{conversation.lastMessage ? shortDate(conversation.lastMessage.createdAt) : ''}</span>
                </span>
                <span className="conv-last">
                  {conversation.aiTyping ? <em>AI is replying…</em> : conversation.lastMessage?.text ?? 'No messages yet'}
                </span>
              </span>
              <span className={`badge ${conversation.mode === 'STAFF' ? 'staff' : 'ai'}`}>{conversation.mode === 'STAFF' ? 'Staff' : 'AI'}</span>
            </button>
          ))}
        </nav>
      </aside>
      <main className="thread">
        {conversation ? (
          <>
            <header className="thread-head">
              <div>
                <h1>{conversation.patientName}</h1>
                <p className="muted">
                  {conversation.mode === 'STAFF' ? (
                    <>Handled by <strong>{conversation.staffName}</strong> · AI paused</>
                  ) : conversation.aiTyping ? (
                    'AI-Coordinator is replying…'
                  ) : (
                    'AI-Coordinator is handling this chat'
                  )}
                </p>
              </div>
              {conversation.mode === 'AI' ? (
                <button className="btn primary" onClick={changeMode} disabled={changingMode}>Take over chat</button>
              ) : (
                <button className="btn ghost" onClick={changeMode} disabled={changingMode}>Hand back to AI</button>
              )}
            </header>

            <div className="message-area">
            <div
              className="messages"
              ref={containerRef}
              tabIndex={0}
              aria-label="Messages"
              onScroll={checkViewport}
            >
              {thread?.hasMore && (
                <button className="load-older" onClick={loadOlder} disabled={loadingOlder}>
                  {loadingOlder ? 'Loading earlier messages…' : 'Load earlier messages'}
                </button>
              )}
              {thread?.items.map((message) =>
                message.sender === 'SYSTEM' ? (
                  <div key={message.key} className="system">{message.text}</div>
                ) : (
                  <div key={message.key} data-message-id={message.id} className={`msg ${message.sender.toLowerCase()}`}>
                    <div className="msg-label">
                      {message.sender === 'PATIENT'
                        ? conversation.patientName
                        : message.sender === 'AI' ? '✦ Dr. Kudos AI' : `${message.senderName} · Staff`}
                    </div>
                    <div className="bubble">
                      <div>{message.text}</div>
                      {message.sender === 'PATIENT' && (
                        message.translation?.lang === targetLanguage ? (
                          message.translation.translated && (
                            <div className="translation">
                              <span className="tl-tag">{languageLabel}</span> {message.translation.text}
                            </div>
                          )
                        ) : (
                          translatingCount > 0 && (
                            <div className="translation loading" role="status" aria-live="polite">
                              <span className="tl-tag">{languageLabel}</span>
                              <span className="tl-spinner" aria-hidden="true" />
                              <span className="tl-loading-text">Translating…</span>
                            </div>
                          )
                        )
                      )}
                      <div className="meta">
                        <span className="message-time">{time(message.createdAt)}</span>
                        {message.sender !== 'PATIENT' && (
                          <MessageStatus pending={message.pending} failed={message.failed} readAt={message.readAt} />
                        )}
                      </div>
                    </div>
                    {message.failed && conversation.mode === 'STAFF' && (
                      <button className="link" disabled={changingMode} onClick={() => send(message)}>Retry</button>
                    )}
                  </div>
                ),
              )}
              {conversation.aiTyping && conversation.mode === 'AI' && (
                <div className="msg ai">
                  <div className="msg-label">✦ Dr. Kudos AI</div>
                  <div className="bubble typing"><span /><span /><span /></div>
                </div>
              )}
            </div>

            {showScrollButton && (
              <button className="scroll-bottom" aria-label="Scroll to bottom" onClick={returnToLatest}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 4v16m-7-7 7 7 7-7" />
                </svg>
              </button>
            )}
            </div>
            <footer className="composer">
              {conversation.mode === 'STAFF' ? (
                <form onSubmit={(event) => {
                  event.preventDefault();
                  send();
                }}>
                  <input
                    aria-label="Reply to patient"
                    aria-invalid={overLimit}
                    aria-describedby={overLimit ? 'draft-limit' : undefined}
                    value={draft}
                    onChange={(event) => {
                      const text = event.target.value;
                      setDrafts((current) => ({ ...current, [selectedConversationId]: text }));
                    }}
                    placeholder={`Reply to ${conversation.patientName} as ${staffName}…`}
                    autoFocus
                  />
                  <button className="btn primary" disabled={!draft.trim() || overLimit || changingMode || !thread}>Send</button>
                </form>
              ) : (
                <div className="locked">
                  The AI assistant is replying to this patient. <button className="link" onClick={changeMode} disabled={changingMode}>Take over</button> to send a message.
                </div>
              )}
              {overLimit && conversation.mode === 'STAFF' && (
                <p id="draft-limit" role="status">Message is {draft.trim().length} characters. Shorten it to 2,000 to send.</p>
              )}
            </footer>
          </>
        ) : (
          <div className="empty">{error ?? 'Loading…'}</div>
        )}
        {error && conversation && (
          <div className="toast" onClick={() => setError(null)}>{error} ✕</div>
        )}
      </main>
      <aside className="details" id="details">
        <section className="card">
          <div className="card-head">
            <h3>Translate incoming</h3>
            {translatingCount > 0 && (
              <span className="tl-status" role="status" aria-live="polite">
                <span className="tl-spinner" aria-hidden="true" /> Translating…
              </span>
            )}
          </div>
          <select
            aria-label="Translation language"
            value={targetLanguage}
            onChange={(event) => setTargetLanguage(event.target.value)}
          >
            {languages.map((language) => (
              <option key={language.code} value={language.code}>{language.label}</option>
            ))}
          </select>
          <p className="hint">Patient messages are machine-translated for staff. Demo uses an offline phrase table; production would call Amazon Translate.</p>
        </section>
        <section className="card">
          <h3>Signed in as</h3>
          <input aria-label="Staff name" value={staffName} onChange={(event) => setStaffName(event.target.value)} />
        </section>
        {conversation && <PatientSummary key={conversation.id} conversation={conversation} />}
      </aside>
    </div>
  );
}
