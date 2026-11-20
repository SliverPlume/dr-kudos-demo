// One timer per conversation batches messages saved before the reply.
// With an LLM configured the timer closes the batch, the model generates the reply,
// and the reply is revealed at a random time inside the same MIN–MAX window.
// Any failure or timeout falls back to the scripted composeReply below.
import { setTimeout as sleep } from 'node:timers/promises';
import { repo, transaction, type Conversation, type Message, type PatientRecords } from './db.ts';
import { pubSub } from './pubsub.ts';
import { complete, errorMessage, llmEnabled, type ChatTurn } from './llm.ts';
import { recordReply } from './recordReplies.ts';
import { assistantInstructions } from './prompts.ts';

const MIN_DELAY_MS = Number(process.env.AI_MIN_DELAY_MS ?? 3000);
const MAX_DELAY_MS = Number(process.env.AI_MAX_DELAY_MS ?? 10000);
const REPLY_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS ?? 25000);
const HISTORY_LIMIT = Number(process.env.AI_HISTORY_LIMIT ?? 20);
const MAX_REPLY_CHARS = 2000;

const timers = new Map<string, NodeJS.Timeout>();
// Replies being generated; takeover aborts them.
const inFlight = new Map<string, AbortController>();

function publishConversation(id: string) {
  const conversation = repo.getConversation(id);
  if (conversation) pubSub.publish('conversationUpdated', conversation);
}

export function scheduleAiReply(conversationId: string) {
  const conversation = repo.getConversation(conversationId);
  if (!conversation || conversation.mode !== 'AI') return;
  // Already waiting or generating: this message joins the batch or the follow-up.
  if (timers.has(conversationId) || inFlight.has(conversationId)) return;
  if (repo.unansweredPatientMessages(conversationId).length === 0) return;

  const startedAt = Date.now();
  const delayMs = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
  // The scripted reply is instant, so it keeps the original single timer.
  const batchWindowMs = llmEnabled ? Math.min(MIN_DELAY_MS, delayMs) : delayMs;
  repo.setAiTyping(conversationId, true);
  publishConversation(conversationId);
  console.log(`[ai] ${conversationId}: replying in ${(delayMs / 1000).toFixed(1)}s`);

  timers.set(
    conversationId,
    setTimeout(
      () => void postAiReply(conversationId, startedAt + delayMs, startedAt + Math.max(MAX_DELAY_MS, batchWindowMs + REPLY_TIMEOUT_MS)),
      batchWindowMs,
    ),
  );
}

export function cancelAiReply(conversationId: string) {
  const timer = timers.get(conversationId);
  if (timer) clearTimeout(timer);
  timers.delete(conversationId);
  inFlight.get(conversationId)?.abort();
  inFlight.delete(conversationId);
  const conversation = repo.getConversation(conversationId);
  if (conversation?.aiTyping) {
    repo.setAiTyping(conversationId, false);
    publishConversation(conversationId);
  }
}

async function postAiReply(conversationId: string, revealAt: number, deadlineAt: number) {
  timers.delete(conversationId);
  const conversation = repo.getConversation(conversationId);
  if (!conversation) return;
  let batch = repo.unansweredPatientMessages(conversationId);

  if (conversation.mode !== 'AI' || batch.length === 0) {
    repo.setAiTyping(conversationId, false);
    publishConversation(conversationId);
    return;
  }

  const controller = new AbortController();
  const { signal } = controller;
  inFlight.set(conversationId, controller);
  try {
    let text = await generateReply(conversation, batch, signal, deadlineAt);
    if (revealAt > Date.now()) await sleep(revealAt - Date.now(), undefined, { signal });

    // Messages saved while generating sit before the reply's seq and would otherwise
    // count as answered, so regenerate with them (scripted once the deadline is near).
    for (let latest = repo.unansweredPatientMessages(conversationId); latest.length > batch.length;
      latest = repo.unansweredPatientMessages(conversationId)) {
      batch = latest;
      text = deadlineAt - Date.now() > 1000
        ? await generateReply(conversation, batch, signal, deadlineAt)
        : composeReply(batch, repo.patientRecords(conversationId));
    }
    if (signal.aborted || repo.getConversation(conversationId)?.mode !== 'AI') return;

    const { reply, readMessages } = transaction(() => {
      const reply = repo.insertMessage({
        conversationId,
        sender: 'AI',
        senderName: 'Dr. Kudos AI',
        senderDeviceId: 'server',
        text: text.slice(0, MAX_REPLY_CHARS),
      });
      const readMessages = repo.markMessagesRead(batch.map((message) => message.id), 'STAFF', reply.createdAt);
      return { reply, readMessages };
    });
    pubSub.publish('messageAdded', reply);
    readMessages.forEach((message) => pubSub.publish('messageUpdated', message));
  } catch (error) {
    if (!signal.aborted) console.error(`[ai] ${conversationId}: reply failed`, error);
  } finally {
    // A takeover replaced or removed our controller and already cleared typing.
    if (inFlight.get(conversationId) === controller) {
      inFlight.delete(conversationId);
      repo.setAiTyping(conversationId, false);
      publishConversation(conversationId);
    }
  }
}

async function generateReply(conversation: Conversation, batch: Message[], signal: AbortSignal, deadlineAt: number) {
  const records = repo.patientRecords(conversation.id);
  if (!llmEnabled) return composeReply(batch, records);
  const startedAt = Date.now();
  const latestPatientText = batch.map((message) => message.text).join('\n');
  try {
    const text = await complete({
      instructions: assistantInstructions(conversation.patientName, latestPatientText, records),
      turns: historyTurns(conversation.id, batch),
      timeoutMs: deadlineAt - startedAt,
      signal,
    });
    console.log(`[ai] ${conversation.id}: model replied in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    return text;
  } catch (error) {
    if (signal.aborted) throw error;
    console.warn(`[ai] ${conversation.id}: model failed (${errorMessage(error)}); using scripted reply`);
    return composeReply(batch, records);
  }
}

/** Recent chat as alternating turns; the unanswered batch is always included. */
function historyTurns(conversationId: string, batch: Message[]): ChatTurn[] {
  const { items } = repo.page(conversationId, null, Math.max(HISTORY_LIMIT, batch.length));
  const turns: ChatTurn[] = [];
  for (const message of items) {
    if (message.sender === 'SYSTEM') continue;
    const role = message.sender === 'PATIENT' ? 'user' : 'assistant';
    const content = message.sender === 'STAFF'
      ? `[Clinic staff${message.senderName ? ` ${message.senderName}` : ''}] ${message.text}`
      : message.text;
    const previous = turns.at(-1);
    if (previous?.role === role) previous.content += `\n${content}`;
    else if (turns.length > 0 || role === 'user') turns.push({ role, content });
  }
  return turns;
}

export function recoverPendingReplies() {
  repo.resetAllTyping();
  for (const conversation of repo.listConversations()) {
    if (conversation.mode === 'AI' && repo.unansweredPatientMessages(conversation.id).length > 0) {
      scheduleAiReply(conversation.id);
    }
  }
}

type Lang = 'en' | 'zh';
interface Intent {
  name: string;
  keywords: RegExp;
  replies: Record<Lang, string[]>;
}

const INTENTS: Intent[] = [
  {
    name: 'human',
    keywords: /real person|human|staff|agent|真人|職員|职员|同事/i,
    replies: {
      en: ["Of course — I've flagged this for our clinic team. A staff member will join this chat shortly."],
      zh: ['沒問題，我已通知診所同事，稍後會有職員加入對話。'],
    },
  },
  {
    name: 'aftercare',
    keywords: /red|swell|swollen|bruis|pain|hurt|itch|side effect|紅|红|腫|肿|痛|瘀|痕/i,
    replies: {
      en: [
        'Mild redness or swelling for 24–48 hours is common after treatment. A cool compress and avoiding heat or makeup for a day usually helps. If it gets worse or you feel unwell, please call us right away.',
        "Sorry to hear that. Some redness is normal for a day or two. If it's spreading, painful, or lasts beyond 48 hours, I'll arrange a nurse to check in with you.",
      ],
      zh: ['療程後 24–48 小時內輕微泛紅或腫脹屬正常，可以冷敷並暫時避免化妝及高溫。如情況加劇或感到不適，請立即致電診所。'],
    },
  },
  {
    name: 'price',
    keywords: /price|cost|how much|fee|\$|package|幾錢|几钱|收費|收费|價錢|价钱|多少錢|多少钱/i,
    replies: {
      en: [
        'Pricing depends on the treatment plan. As a guide, Emface starts from HK$4,800 per session and anti-wrinkle injections from HK$2,200. Your clinician will confirm after a consultation.',
      ],
      zh: ['價錢會按療程計劃而定。參考價：Emface 每次由 HK$4,800 起，抗皺針由 HK$2,200 起，醫生會在諮詢後確認。'],
    },
  },
  {
    name: 'treatment',
    keywords: /emface|botox|filler|hifu|laser|peel|skin|treatment|wrinkle|療程|疗程|肉毒|激光|皮膚|皮肤|皺紋|皱纹/i,
    replies: {
      en: [
        'Great question. Emface combines RF and muscle stimulation to lift and tone — sessions take about 20 minutes with no downtime. Would you like to book a consultation to see if it suits you?',
      ],
      zh: ['Emface 結合射頻及肌肉刺激，有助提升緊緻，每次約 20 分鐘，毋須復原期。想預約諮詢看看是否適合你嗎？'],
    },
  },
  {
    name: 'hours',
    keywords: /open|hour|close|where|address|location|營業|营业|幾點|几点|地址|喺邊|在哪/i,
    replies: {
      en: ["We're open Mon–Sat, 10:00 am – 8:00 pm, at 18/F, 33 Des Voeux Road Central. Closed on Sundays and public holidays."],
      zh: ['診所營業時間為星期一至六上午 10 時至晚上 8 時，地址：中環德輔道中 33 號 18 樓。星期日及公眾假期休息。'],
    },
  },
  {
    name: 'thanks',
    keywords: /thank|thx|cheers|唔該|多謝|谢谢|謝謝/i,
    replies: {
      en: ["You're very welcome! Let me know if there's anything else I can help with. 😊"],
      zh: ['不用客氣！如有其他問題隨時找我 😊'],
    },
  },
  {
    name: 'greeting',
    keywords: /^(hi|hello|hey|good (morning|afternoon|evening))\b|你好|哈囉|早晨|午安/i,
    replies: {
      en: ["Hi there! I'm the Dr. Kudos assistant. How can I help you today?"],
      zh: ['你好！我是 Dr. Kudos 助理，請問有甚麼可以幫到你？'],
    },
  },
];

const FALLBACK: Record<Lang, string[]> = {
  en: [
    "Thanks for your message! Could you tell me a bit more so I can help?",
    "Got it. I'll make sure the team sees this. Is there anything else you'd like to add?",
  ],
  zh: ['收到你的訊息。可以再多說一點，讓我更好地幫你嗎？'],
};

const pick = <T,>(items: T[]) => items[Math.floor(Math.random() * items.length)];

export function composeReply(messages: Message[], records: PatientRecords): string {
  const combined = messages.map((message) => message.text).join('\n');
  const language: Lang = /[\u3400-\u9fff]/.test(combined) ? 'zh' : 'en';

  const recordLanguage = /[\u3040-\u30ff]/.test(combined) ? 'ja' : language;
  const recordAnswers = new Set<string>();
  const remaining: string[] = [];
  for (const question of combined.split(/\n|[?？]|\s+and\s+(?=when|what|can I)|同埋|另外/i).filter((part) => part.trim())) {
    const answer = recordReply(question, records, recordLanguage);
    if (answer) recordAnswers.add(answer);
    else remaining.push(question);
  }
  const matchedIntents = INTENTS.filter((intent) => intent.keywords.test(remaining.join('\n'))).slice(0, 2);
  const replyParts = matchedIntents.length
    ? matchedIntents.map((intent) => pick(intent.replies[language]))
    : recordAnswers.size ? [] : [pick(FALLBACK[language])];

  // Drop a lone greeting if we already have something substantive.
  if (matchedIntents.length === 2 && matchedIntents[1].name === 'greeting') replyParts.pop();
  return [...recordAnswers, ...replyParts].join('\n\n');
}
