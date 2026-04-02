const express = require('express');
const admin = require('firebase-admin');
const fetch = require('node-fetch');
const cron = require('node-cron');

const app = express();
app.use(express.json());

// ══ CORS — السماح لموقع قضاء ══
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// ══ Firebase Admin Init ══
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// ══ أسماء الصلوات ══
const NAMES = {
  Fajr: 'الفجر',
  Dhuhr: 'الظهر',
  Asr: 'العصر',
  Maghrib: 'المغرب',
  Isha: 'العشاء'
};
const KEYS = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

const AYAH = 'فَخَلَفَ مِنۢ بَعْدِهِمْ خَلْفٌ أَضَاعُوا۟ الصَّلَوٰةَ';

// ══ جلب أوقات الصلاة لإحداثيات معينة ══
async function getPrayerTimes(lat, lng, date) {
  const url = `https://api.aladhan.com/v1/timings/${date}?latitude=${lat}&longitude=${lng}&method=2`;
  const res = await fetch(url);
  const json = await res.json();
  return json.data.timings;
}

// ══ إرسال إشعار لمستخدم واحد ══
async function sendNotification(token, title, body, data = {}) {
  try {
    await admin.messaging().send({
      token,
      notification: { title, body },
      data,
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'qadaa_prayers'
        }
      },
      webpush: {
        notification: {
          title,
          body,
          icon: 'https://eoovd.store/image/salah.png',
          badge: 'https://eoovd.store/image/salah.png',
          requireInteraction: true,
          vibrate: [300, 100, 300]
        },
        fcmOptions: {
          link: 'https://eoovd.store/qadaa.html'
        }
      }
    });
  } catch (err) {
    console.error('Error sending to token:', token, err.message);
    // إذا Token منتهي الصلاحية احذفه
    if (err.code === 'messaging/registration-token-not-registered') {
      await db.collection('push_tokens').doc(token).delete();
    }
  }
}

// ══ جدولة إشعارات كل المستخدمين ══
async function scheduleAllUsers() {
  console.log('📅 جدولة الإشعارات لجميع المستخدمين...');

  const now = new Date();
  const dateStr = `${now.getDate()}-${now.getMonth() + 1}-${now.getFullYear()}`;

  // جلب كل المستخدمين المشتركين
  const snapshot = await db.collection('push_tokens').get();
  if (snapshot.empty) {
    console.log('لا يوجد مشتركون بعد');
    return;
  }

  for (const doc of snapshot.docs) {
    const { token, lat, lng, uid } = doc.data();
    if (!token || !lat || !lng) continue;

    try {
      const times = await getPrayerTimes(lat, lng, dateStr);

      // جلب حالة صلوات المستخدم اليوم
      let todayStatus = {};
      if (uid) {
        const userDoc = await db.collection('users').doc(uid).get();
        if (userDoc.exists) {
          const userData = userDoc.data();
          todayStatus = userData.todayStatus || {};
        }
      }

      const todayMidnight = new Date();
      todayMidnight.setHours(0, 0, 0, 0);

      // أوقات الصلاة كـ timestamps
      const prayerTs = {};
      KEYS.forEach(k => {
        const t = times[k];
        if (!t) return;
        const [h, m] = t.split(':').map(Number);
        const d = new Date(todayMidnight);
        d.setHours(h, m, 0, 0);
        prayerTs[k] = d.getTime();
      });

      // نهاية كل نافذة
      const windowEnds = {
        Fajr:    prayerTs['Dhuhr']   ? prayerTs['Dhuhr']   - 60000 : null,
        Dhuhr:   prayerTs['Asr']     ? prayerTs['Asr']     - 60000 : null,
        Asr:     prayerTs['Maghrib'] ? prayerTs['Maghrib'] - 60000 : null,
        Maghrib: prayerTs['Isha']    ? prayerTs['Isha']    - 60000 : null,
        Isha:    new Date(todayMidnight).setHours(23, 59, 0, 0)
      };

      const nowMs = Date.now();

      KEYS.forEach(key => {
        const prayerTime = prayerTs[key];
        if (!prayerTime) return;

        const prayerKey = key.toLowerCase();
        const alreadyDone = todayStatus[prayerKey] === 'done';
        if (alreadyDone) return;

        // إشعار دخول وقت الصلاة
        const diff1 = prayerTime - nowMs;
        if (diff1 > 0 && diff1 < 24 * 60 * 60 * 1000) {
          setTimeout(async () => {
            // تحقق مجدداً من حالة الصلاة
            let currentStatus = {};
            if (uid) {
              const userDoc = await db.collection('users').doc(uid).get();
              if (userDoc.exists) currentStatus = userDoc.data().todayStatus || {};
            }
            if (currentStatus[prayerKey] !== 'done') {
              await sendNotification(
                token,
                '🕌 حان وقت ' + NAMES[key],
                AYAH + '\n— سورة مريم: ٥٩'
              );
            }
          }, diff1);
        }

        // إشعار تحذير قبل 10 دقائق
        const windowEnd = windowEnds[key];
        if (!windowEnd) return;
        const warningTime = windowEnd - 10 * 60 * 1000;
        const diff2 = warningTime - nowMs;

        if (diff2 > 0 && diff2 < 24 * 60 * 60 * 1000) {
          setTimeout(async () => {
            let currentStatus = {};
            if (uid) {
              const userDoc = await db.collection('users').doc(uid).get();
              if (userDoc.exists) currentStatus = userDoc.data().todayStatus || {};
            }
            if (currentStatus[prayerKey] !== 'done') {
              await sendNotification(
                token,
                '⚠️ ستخسر قلباً خلال 10 دقائق!',
                'وقت ' + NAMES[key] + ' على وشك الانتهاء\nسجّل صلاتك الآن ❤️'
              );
            }
          }, diff2);
        }
      });

    } catch (err) {
      console.error('خطأ في معالجة مستخدم:', uid, err.message);
    }
  }

  console.log(`✅ تمت الجدولة لـ ${snapshot.size} مستخدم`);
}

// ══ API: تسجيل Token جديد ══
app.post('/register', async (req, res) => {
  const { token, lat, lng, uid } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });

  await db.collection('push_tokens').doc(token).set({
    token,
    lat: lat || 36.7372,   // الجزائر افتراضي
    lng: lng || 3.0865,
    uid: uid || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  res.json({ success: true });
});

// ══ API: إلغاء الاشتراك ══
app.post('/unregister', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });
  await db.collection('push_tokens').doc(token).delete();
  res.json({ success: true });
});

// ══ Health check ══
app.get('/', (req, res) => res.json({ status: 'قضاء Push Server يعمل ✅' }));

// ══ جدولة يومية — كل يوم الساعة 3 فجراً ══
cron.schedule('0 3 * * *', () => {
  scheduleAllUsers();
});

// ══ تشغيل فوري عند البدء ══
scheduleAllUsers();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
