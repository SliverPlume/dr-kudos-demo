import { db, repo, transaction, type Sender } from './db.ts';

const HISTORY: [Sender, string][] = [
  ['PATIENT', 'Hi, I would like to book a consultation.'],
  ['AI', "Hi Chloe! I'd be happy to help. Are you interested in a particular treatment?"],
  ['PATIENT', "I've been reading about Emface."],
  ['AI', 'Emface combines RF and muscle stimulation to lift and tone — sessions take about 20 minutes with no downtime.'],
  ['PATIENT', 'How much is an Emface session?'],
  ['AI', 'Emface starts from HK$4,800 per session. Many patients choose a course of 4 sessions.'],
  ['PATIENT', 'Is there any availability this Saturday?'],
  ['AI', 'We have Saturday at 11:30 am or 2:00 pm. Which would you prefer?'],
  ['PATIENT', 'Saturday 11:30 works for me.'],
  ['AI', "You're booked for Saturday 11:30 am with Dr. Wong. You'll get a reminder the day before."],
  ['PATIENT', 'Thank you!'],
  ['AI', "You're very welcome! See you on Saturday. 😊"],
];

const FOLLOW_UP: [Sender, string][] = [
  ['AI', 'Hi Chloe, how are you feeling after your Emface session yesterday?'],
  ['PATIENT', 'My face is a bit red after the treatment.'],
  ['AI', 'Mild redness for 24–48 hours is common. A cool compress helps. Let us know if it lasts longer.'],
  ['PATIENT', 'OK it is much better today, thanks'],
  ['AI', 'Great to hear! Remember to wear sunscreen this week.'],
];

function seedConversations(now: number) {
  const dayMs = 24 * 60 * 60 * 1000;

  // Enough history across several months to exercise cursor pagination.
  repo.createConversation('conv-chloe', 'Chloe Chan', new Date(now - 120 * dayMs).toISOString());
  let messageTime = now - 120 * dayMs;
  for (let round = 0; round < 4; round++) {
    for (const [sender, text] of round % 2 === 0 ? HISTORY : FOLLOW_UP) {
      messageTime += 3 * 60 * 1000;
      repo.insertMessage({
        conversationId: 'conv-chloe',
        sender,
        text,
        senderName: sender === 'AI' ? 'Dr. Kudos AI' : null,
        senderDeviceId: sender === 'AI' ? 'server' : 'seed',
        createdAt: new Date(messageTime).toISOString(),
      });
    }
    messageTime += 28 * dayMs;
  }

  repo.createConversation('conv-marcus', 'Marcus Lee', new Date(now - 2 * dayMs).toISOString());
  repo.insertMessage({
    conversationId: 'conv-marcus',
    sender: 'PATIENT',
    senderDeviceId: 'seed',
    text: '我上次做 Emface 是甚麼時候？',
    createdAt: new Date(now - 2 * dayMs).toISOString(),
  });
  repo.insertMessage({
    conversationId: 'conv-marcus',
    sender: 'AI',
    senderName: 'Dr. Kudos AI',
    senderDeviceId: 'server',
    text: '記錄顯示你上次的 Emface 療程大約在三個月前。需要我幫你查看覆診時段嗎？',
    createdAt: new Date(now - 2 * dayMs + 60000).toISOString(),
  });

  repo.createConversation('conv-sakura', 'Sakura Tanaka', new Date(now - dayMs).toISOString());
  repo.insertMessage({
    conversationId: 'conv-sakura',
    sender: 'PATIENT',
    senderDeviceId: 'seed',
    text: '予約を変更できますか？',
    createdAt: new Date(now - dayMs).toISOString(),
  });
  repo.insertMessage({
    conversationId: 'conv-sakura',
    sender: 'AI',
    senderName: 'Dr. Kudos AI',
    senderDeviceId: 'server',
    text: 'No problem. Which date and time would suit you better?',
    createdAt: new Date(now - dayMs + 60000).toISOString(),
  });

  // Historical messages were all received long ago.
  db.exec(`UPDATE messages SET status = 'DELIVERED', delivered_at = created_at`);
  console.log('[seed] demo data created');
}

// Dates are chosen on first import. A restart must preserve edits and cancellations.
export function seedDemoData(now = new Date()) {
  transaction(() => {
    if (repo.listConversations().length === 0) seedConversations(now.getTime());
    const visit = db.prepare(`
      INSERT INTO clinical_visits (id, conversation_id, visit_date, treatment, clinician, summary)
      VALUES (?, ?, date(?, '+8 hours', ?), ?, ?, ?) ON CONFLICT(id) DO NOTHING`);
    const appointment = db.prepare(`
      INSERT INTO appointments (id, conversation_id, starts_at, service, clinician, status)
      VALUES (?, ?, date(?, '+8 hours', '+7 days', ?) || 'T' || ? || ':00+08:00', ?, ?, 'confirmed')
      ON CONFLICT(id) DO NOTHING`);
    const patients = [
      { id: 'conv-chloe', clinician: 'Dr. Wong', visits: [
        [63, 'Emface', 'First Emface session completed.'],
        [28, 'Emface', 'Second Emface session completed.'],
      ], weekday: 6, time: '11:30', service: 'Emface' },
      { id: 'conv-marcus', clinician: 'Dr. Lam', visits: [
        [84, 'Emface', 'Emface session completed.'],
        [17, 'HIFU', 'HIFU session completed.'],
      ], weekday: 5, time: '15:00', service: 'Follow-up' },
      { id: 'conv-sakura', clinician: 'Dr. Chan', visits: [
        [49, 'Consultation', 'Initial skin consultation completed.'],
        [12, 'Follow-up', 'Reviewed progress at follow-up.'],
      ], weekday: 1, time: '10:30', service: 'Consultation' },
    ] as const;
    for (const patient of patients) {
      if (!repo.getConversation(patient.id)) continue;
      for (const [index, [daysAgo, treatment, summary]] of patient.visits.entries()) {
        visit.run(`${patient.id}-visit-${index + 1}`, patient.id, now.toISOString(), `-${daysAgo} days`,
          treatment, patient.clinician, summary);
      }
      appointment.run(`${patient.id}-appointment-1`, patient.id, now.toISOString(), `weekday ${patient.weekday}`,
        patient.time, patient.service, patient.clinician);
    }
  });
}
