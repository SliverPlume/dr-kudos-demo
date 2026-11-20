import type { PatientRecords } from './db.ts';

type Language = 'en' | 'zh' | 'ja';

const serviceNames: Record<string, { zh: string; ja: string; aliases: RegExp }> = {
  Consultation: { zh: '諮詢', ja: 'カウンセリング', aliases: /consultation|諮詢|咨询|カウンセリング/i },
  'Follow-up': { zh: '覆診', ja: '再診', aliases: /follow[ -]?up|覆診|覆诊|復診|复诊|再診/i },
  HIFU: { zh: 'HIFU', ja: 'HIFU', aliases: /hifu|聚焦超聲波|ハイフ/i },
  Emface: { zh: 'Emface', ja: 'Emface', aliases: /emface|エムフェイス/i },
};

function serviceName(name: string, language: Language) {
  return language === 'en' ? name : serviceNames[name]?.[language] ?? name;
}

const history = /\b(?:my|the) (?:last|previous|most recent)\b|when (?:was|did) (?:my|i)|treatment history|上(?:一)?次|最近一次|病歷|病历|前回|最後の/i;
// Fall back to the latest visit only for a generic question. An unmatched
// treatment name must never silently select a different treatment.
function asksAboutAnyVisit(question: string) {
  const remainder = question.toLowerCase()
    .replace(/\b(when|what|was|is|did|i|my|the|date|of|show|me|most|recent|last|previous|visit|session|appointment|treatment|history|have|do)\b/g, '')
    .replace(/幾時|何時|甚麼時候|什麼時候|時間|最近一次|上一次|上次|我|的|嘅|係|是|做過|做咗|做了|做|咩|甚麼|什麼|療程|就診|病歷|前回の診察はいつでしたか/g, '');
  return /^[\s?？.!。！]*$/u.test(remainder);
}
const bookingChange = /reschedul|cancel|postpone|(?:change|move).*(?:appointment|booking)|\bbook\b|(?:make|schedule|arrange|reserve|request) (?:an? |my |a new )?(?:appointment|booking|visit|consultation)|availab|\bslots?\b|works for me|free on|改期|更改|改時間|取消|(?:想|需要|安排|新增|幫我|帮我)(?:一個|一节|一節)?(?:預約|预约|約)|預約(?:一個|一節|諮詢|療程)|预约(?:一个|一节|咨询|疗程)|有冇位|有位|空[檔档]|予約.*(?:変更|キャンセル|取りたい|したい)|空いて/i;
const appointmentLookup = /appointment|booking|next (?:visit|session|consultation|follow[ -]?up)|預約|预约|下次|下一次|幾時覆診|予約|次回/i;

export function recordReply(question: string, records: PatientRecords, language: Language): string | null {
  if (bookingChange.test(question)) {
    return {
      en: 'Please contact the clinic team to confirm availability or arrange a booking, change or cancellation.',
      zh: '查詢空檔、新預約、改期或取消，都需要診所職員確認。請聯絡診所同事安排。',
      ja: '空き状況の確認、ご予約、変更、キャンセルはクリニックのスタッフにご連絡ください。',
    }[language];
  }

  if (history.test(question)) {
    const named = records.visits.find(({ treatment }) =>
      question.toLowerCase().includes(treatment.toLowerCase()) || serviceNames[treatment]?.aliases.test(question));
    const visit = named ?? (asksAboutAnyVisit(question) ? records.visits[0] : undefined);
    if (!visit) return {
      en: 'I could not find a matching visit in your record.',
      zh: '你的病歷中沒有符合這項查詢的就診紀錄。',
      ja: '該当する受診記録はありません。',
    }[language];
    const service = serviceName(visit.treatment, language);
    return {
      en: `Your most recent ${service} visit was on ${visit.date} with ${visit.clinician}.`,
      zh: `你上次的${service}紀錄是 ${visit.date}，由 ${visit.clinician} 跟進。`,
      ja: `前回の${service}は ${visit.date} で、担当は ${visit.clinician} でした。`,
    }[language];
  }

  if (!appointmentLookup.test(question)) return null;
  const appointment = records.nextAppointment;
  if (!appointment) return {
    en: 'There is no upcoming confirmed appointment in your record.',
    zh: '你的紀錄中沒有已確認的未來預約。',
    ja: '今後の確定済みの予約はありません。',
  }[language];
  const service = serviceName(appointment.service, language);
  return {
    en: `Your next confirmed appointment is on ${appointment.startsAtHongKong} (Hong Kong time) for ${service} with ${appointment.clinician}.`,
    zh: `你下次已確認的預約是 ${appointment.startsAtHongKong}（香港時間），項目是${service}，由 ${appointment.clinician} 跟進。`,
    ja: `次の予約は ${appointment.startsAtHongKong}（香港時間）の${service}で、担当は ${appointment.clinician} です。`,
  }[language];
}
