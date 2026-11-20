// Unknown phrases are translated by the LLM when configured; otherwise they keep
// their original text with translated=false.
import { repo } from './db.ts';
import { complete, errorMessage, limitConcurrency, llmEnabled } from './llm.ts';
import { LANGUAGE_NAMES, translatorInstructions } from './prompts.ts';

export interface Translation {
  lang: string;
  text: string;
  translated: boolean;
}

export interface Translator {
  translate(text: string, targetLang: string): Translation | Promise<Translation>;
}

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'zh', label: '繁體中文' },
  { code: 'cn', label: '简体中文' },
  { code: 'ja', label: '日本語' },
];

type PhraseEntry = { en: string; zh: string; cn: string; ja: string; alt?: string[] };

const PHRASES: PhraseEntry[] = [
  {
    en: 'Hi, I would like to book a consultation.',
    zh: '你好，我想預約諮詢。',
    cn: '你好，我想预约咨询。',
    ja: 'こんにちは、カウンセリングを予約したいです。',
    alt: ["hi i'd like to book a consultation", '你好我想約個諮詢', '你好我想約時間'],
  },
  {
    en: 'When was my last Emface?',
    zh: '我上次做 Emface 是甚麼時候？',
    cn: '我上次做 Emface 是什么时候？',
    ja: '前回の Emface はいつでしたか？',
    alt: ['我上次幾時做 emface', '我上次做emface係幾時'],
  },
  {
    en: 'How much is an Emface session?',
    zh: 'Emface 療程收費多少？',
    cn: 'Emface 疗程收费多少？',
    ja: 'Emface の施術はいくらですか？',
    alt: ['emface幾錢', 'emface 幾錢一次'],
  },
  {
    en: 'Is there any availability this Saturday?',
    zh: '這個星期六有空檔嗎？',
    cn: '这个星期六有空档吗？',
    ja: '今週の土曜日は空いていますか？',
    alt: ['今個星期六有冇位', '星期六有冇位'],
  },
  {
    en: 'My face is a bit red after the treatment.',
    zh: '療程後我的臉有點紅。',
    cn: '疗程后我的脸有点红。',
    ja: '施術後、顔が少し赤くなっています。',
    alt: ['做完之後塊面有啲紅'],
  },
  {
    en: 'Can I reschedule my appointment?',
    zh: '我可以改期嗎？',
    cn: '我可以改期吗？',
    ja: '予約を変更できますか？',
    alt: ['可唔可以改期'],
  },
  {
    en: 'What are your opening hours?',
    zh: '你們的營業時間是？',
    cn: '你们的营业时间是？',
    ja: '営業時間を教えてください。',
    alt: ['你哋幾點開門'],
  },
  {
    en: 'I would like to talk to a real person.',
    zh: '我想和真人職員對話。',
    cn: '我想和真人职员对话。',
    ja: 'スタッフと直接話したいです。',
    alt: ["i'd like to talk to a real person", '我想同真人傾'],
  },
  {
    en: 'Thank you!',
    zh: '謝謝！',
    cn: '谢谢！',
    ja: 'ありがとうございます！',
    alt: ['thanks', 'thank you', '唔該', '多謝', 'thx'],
  },
  {
    en: 'Hello',
    zh: '你好',
    cn: '你好',
    ja: 'こんにちは',
    alt: ['hi', 'hey'],
  },
  {
    en: 'Saturday 11:30 works for me.',
    zh: '星期六 11:30 可以。',
    cn: '星期六 11:30 可以。',
    ja: '土曜日の 11:30 で大丈夫です。',
    alt: ['saturday 1130 works for me', '星期六1130得'],
  },
  {
    en: 'Is there any downtime after Emface?',
    zh: 'Emface 之後需要復原期嗎？',
    cn: 'Emface 之后需要恢复期吗？',
    ja: 'Emface の後にダウンタイムはありますか？',
  },
];

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim();

const phraseIndex = new Map<string, PhraseEntry>();
for (const row of PHRASES) {
  for (const phrase of [row.en, row.zh, row.cn, row.ja, ...(row.alt ?? [])]) {
    phraseIndex.set(normalize(phrase), row);
  }
}

export const phraseTranslator: Translator = {
  translate(text, targetLang) {
    const row = phraseIndex.get(normalize(text));
    const target = row?.[targetLang as keyof PhraseEntry];
    if (typeof target === 'string') {
      return { lang: targetLang, text: target, translated: target !== text };
    }
    return { lang: targetLang, text, translated: false };
  },
};

const hasPhrase = (text: string, targetLang: string) =>
  typeof phraseIndex.get(normalize(text))?.[targetLang as keyof PhraseEntry] === 'string';

const TRANSLATE_TIMEOUT_MS = Number(process.env.AI_TRANSLATE_TIMEOUT_MS ?? 20000);
const translationSlot = limitConcurrency(Number(process.env.AI_TRANSLATE_CONCURRENCY ?? 4));
const pendingTranslations = new Map<string, Promise<Translation>>();

// Dictionary first, then the SQLite cache, then the model. Failures are not cached
// and return the original text with translated=false, as before.
export const aiTranslator: Translator = {
  translate(text, targetLang) {
    if (hasPhrase(text, targetLang) || !llmEnabled || !LANGUAGE_NAMES[targetLang] || !text.trim()) {
      return phraseTranslator.translate(text, targetLang);
    }
    const cached = repo.getTranslation(text, targetLang);
    if (cached) return { lang: targetLang, ...cached };

    const key = `${targetLang}\u0000${text}`;
    let pending = pendingTranslations.get(key);
    if (!pending) {
      pending = translationSlot(() => translateWithModel(text, targetLang))
        .finally(() => pendingTranslations.delete(key));
      pendingTranslations.set(key, pending);
    }
    return pending;
  },
};

async function translateWithModel(text: string, targetLang: string): Promise<Translation> {
  try {
    const output = await complete({
      instructions: translatorInstructions(LANGUAGE_NAMES[targetLang]),
      turns: [{ role: 'user', content: text }],
      timeoutMs: TRANSLATE_TIMEOUT_MS,
    });
    const translated = normalize(output) !== normalize(text);
    const result = translated ? output : text;
    repo.saveTranslation(text, targetLang, result, translated);
    return { lang: targetLang, text: result, translated };
  } catch (error) {
    console.warn(`[translate] ${targetLang}: model failed (${errorMessage(error)})`);
    return { lang: targetLang, text, translated: false };
  }
}

export const translator: Translator = aiTranslator;
