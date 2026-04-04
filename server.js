const express = require('express');
const admin = require('firebase-admin');
const fetch = require('node-fetch');
const cron = require('node-cron');
 
const app = express();
app.use(express.json());
 
// ══ CORS ══
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
 
// ══ Firebase Admin ══
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
 
// ══ الثوابت ══
const NAMES = { Fajr:'الفجر', Dhuhr:'الظهر', Asr:'العصر', Maghrib:'المغرب', Isha:'العشاء' };
const KEYS  = ['Fajr','Dhuhr','Asr','Maghrib','Isha'];
const AYAH  = 'فَخَلَفَ مِنۢ بَعْدِهِمْ خَلْفٌ أَضَاعُوا۟ الصَّلَوٰةَ — سورة مريم: ٥٩';
 
// ══ جلب أوقات الصلاة ══
// نمرر timezone للـ API لضمان الوقت المحلي الصحيح
async function getPrayerTimes(lat, lng, timezone) {
  const now = new Date();
  const date = `${now.getDate()}-${now.getMonth()+1}-${now.getFullYear()}`;
  const tz = timezone || 'Africa/Algiers';
  const url = `https://api.aladhan.com/v1/timings/${date}?latitude=${lat}&longitude=${lng}&method=2&timezonestring=${encodeURIComponent(tz)}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.code !== 200) throw new Error('Aladhan API error: ' + json.status);
  return json.data.timings;
}
 
// ══ إرسال إشعار FCM ══
async function sendNotification(token, title, body) {
  try {
    await admin.messaging().send({
      token,
      notification: { title, body },
      android: {
        priority: 'high',
        notification: { sound: 'default', channelId: 'qadaa_prayers' }
      },
      webpush: {
        notification: {
          title, body,
          icon: 'https://eoovd.store/image/salah.png',
          badge: 'https://eoovd.store/image/salah.png',
          requireInteraction: true,
          vibrate: [300, 100, 300, 100, 300],
          tag: 'prayer-fcm-' + Date.now(),
          renotify: true
        },
        fcmOptions: { link: 'https://eoovd.store/qadaa.html' }
      }
    });
    console.log(`✅ إشعار أُرسل: ${title}`);
  } catch (err) {
    console.error('❌ فشل الإرسال:', err.message);
    if (err.code === 'messaging/registration-token-not-registered') {
      await db.collection('push_tokens').doc(token).delete();
      console.log('🗑️ Token محذوف (منتهي الصلاحية)');
    }
  }
}
 
// ══ مخزن الـ cron jobs النشطة (token → [jobs]) ══
const activeCrons = new Map();
 
function cancelUserCrons(token) {
  if (activeCrons.has(token)) {
    activeCrons.get(token).forEach(j => j.stop());
    activeCrons.delete(token);
  }
}
 
// ══ جدولة إشعارات مستخدم واحد بـ cron حقيقي ══
async function scheduleUserNotifications(tokenDoc) {
  const { token, lat, lng, uid, timezone } = tokenDoc;
  if (!token || !lat || !lng) return;
 
  // ألغِ الجدولة القديمة لهذا المستخدم
  cancelUserCrons(token);
 
  let times;
  try {
    times = await getPrayerTimes(lat, lng, timezone);
  } catch (e) {
    console.error('خطأ في جلب الأوقات لـ', uid, e.message);
    return;
  }
 
  const jobs = [];
 
  // نهاية نافذة كل صلاة (بداية التالية)
  const ends = {
    Fajr:    times['Dhuhr'],
    Dhuhr:   times['Asr'],
    Asr:     times['Maghrib'],
    Maghrib: times['Isha'],
    Isha:    '23:59'
  };
 
  KEYS.forEach(key => {
    const timeStr = times[key];
    if (!timeStr) return;
 
    // "HH:MM" أو "HH:MM (TZ)" — خذ أول جزء
    const clean = timeStr.split(' ')[0];
    const [h, m] = clean.split(':').map(Number);
    if (isNaN(h) || isNaN(m)) return;
 
    // ── إشعار 1: عند دخول وقت الصلاة ──
    // cron: "m h * * *"
    const cronExpr1 = `${m} ${h} * * *`;
    try {
      const job1 = cron.schedule(cronExpr1, async () => {
        // تحقق من حالة الصلاة في Firestore لحظة الإرسال
        let done = false;
        if (uid) {
          const snap = await db.collection('users').doc(uid).get();
          if (snap.exists) {
            const d = snap.data();
            const today = new Date().toISOString().slice(0,10);
            if (d.todayStatusDay === today && d.todayStatus?.[key.toLowerCase()] === 'done') {
              done = true;
            }
          }
        }
        if (!done) {
          await sendNotification(token, '🕌 حان وقت ' + NAMES[key], AYAH);
        }
      }, { timezone: timezone || 'Africa/Algiers' });
      jobs.push(job1);
    } catch(e) { console.error('خطأ في cron:', key, e.message); }
 
    // ── إشعار 2: قبل 10 دقائق من نهاية الوقت ──
    const endStr = (ends[key] || '').split(' ')[0];
    if (!endStr) return;
    const [eh, em] = endStr.split(':').map(Number);
    if (isNaN(eh) || isNaN(em)) return;
 
    // احسب وقت التحذير = نهاية الوقت − 11 دقيقة (هامش دقيقة للـ cron)
    let wm = em - 11;
    let wh = eh;
    if (wm < 0) { wm += 60; wh -= 1; }
    if (wh < 0) wh = 23;
 
    const cronExpr2 = `${wm} ${wh} * * *`;
    try {
      const job2 = cron.schedule(cronExpr2, async () => {
        let done = false;
        if (uid) {
          const snap = await db.collection('users').doc(uid).get();
          if (snap.exists) {
            const d = snap.data();
            const today = new Date().toISOString().slice(0,10);
            if (d.todayStatusDay === today && d.todayStatus?.[key.toLowerCase()] === 'done') {
              done = true;
            }
          }
        }
        if (!done) {
          await sendNotification(
            token,
            '⏰ وقت ' + NAMES[key] + ' ينتهي قريباً',
            'تبقّت 10 دقائق — سجّل صلاتك الآن ❤️'
          );
        }
      }, { timezone: timezone || 'Africa/Algiers' });
      jobs.push(job2);
    } catch(e) { console.error('خطأ في cron warning:', key, e.message); }
  });
 
  activeCrons.set(token, jobs);
  console.log(`📅 جُدول ${jobs.length} إشعار لـ ${uid || token.slice(0,10)}`);
}
 
// ══ جدولة جميع المستخدمين ══
async function scheduleAllUsers() {
  console.log('🔄 جدولة جميع المستخدمين...');
  try {
    const snap = await db.collection('push_tokens').get();
    if (snap.empty) { console.log('لا يوجد مشتركون'); return; }
 
    for (const doc of snap.docs) {
      await scheduleUserNotifications(doc.data());
    }
    console.log(`✅ تمت الجدولة لـ ${snap.size} مستخدم`);
  } catch(e) {
    console.error('خطأ في scheduleAllUsers:', e.message);
  }
}
 
// ══ API: تسجيل Token ══
app.post('/register', async (req, res) => {
  const { token, lat, lng, uid, timezone } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });
 
  const docData = {
    token,
    lat:      lat || 36.7372,
    lng:      lng || 3.0865,
    uid:      uid || null,
    timezone: timezone || 'Africa/Algiers',
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
 
  await db.collection('push_tokens').doc(token).set(docData, { merge: true });
 
  // جدوِل فوراً لهذا المستخدم
  scheduleUserNotifications(docData).catch(console.error);
 
  console.log(`📲 Token مسجّل: ${uid || 'ضيف'} — ${timezone || 'Africa/Algiers'}`);
  res.json({ success: true });
});
 
// ══ API: إلغاء الاشتراك ══
app.post('/unregister', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });
  cancelUserCrons(token);
  await db.collection('push_tokens').doc(token).delete();
  res.json({ success: true });
});
 
// ══ Health check ══
app.get('/', (req, res) => res.json({
  status: '🕌 قضاء Push Server يعمل',
  users: activeCrons.size,
  time: new Date().toISOString()
}));
 
// ══ إعادة جدولة كل يوم الساعة 2:00 فجراً (لليوم الجديد) ══
cron.schedule('0 2 * * *', () => {
  console.log('🌙 إعادة جدولة يومية...');
  scheduleAllUsers();
});
 
// ══ تشغيل فوري عند البدء ══
scheduleAllUsers();
 
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
