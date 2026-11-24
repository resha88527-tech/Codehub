const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://jrjdkojqmpgssaxiwiem.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_cIQbKQbFKqYKTWd3sJuu6A_XRMkQmby';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

console.log('🚀 Code Hub Worker يعمل الآن وينتظر المهام الجديدة...');

// دالة تنفيذ المهمة الحقيقية خطوة بخطوة
async function processTask(task) {
  console.log(`▶️ بدء تنفيذ المهمة #${task.id} للمسار: ${task.track}`);
  
  let currentLogs = [
    { msg: `تم استلام المهمة من قِبل السيرفر (${task.track})`, time: new Date().toLocaleTimeString('ar-EG'), type: 'info' }
  ];

  // تحديث الحالة إلى "نشط"
  await supabase
    .from('tasks_queue')
    .update({ status: 'running', logs: currentLogs })
    .eq('id', task.id);

  // حلقة التنفيذ الفعلية لكل وحدة/فصل
  for (let i = 1; i <= task.total_units; i++) {
    // ---------------------------------------------------------
    // هنا تضع الكود البرمجي الحقيقي الخاص بالمهمة (API Call / Script)
    // مثال: await executeRealStep(task.session_identifier, i);
    // ---------------------------------------------------------
    await new Promise(resolve => setTimeout(resolve, 1500)); // محاكاة زمن التنفيذ الفعلي (1.5 ثانية)

    currentLogs.unshift({
      msg: `السيرفر: تم تنفيذ الوحدة رقم ${i} من ${task.total_units} بنجاح`,
      time: new Date().toLocaleTimeString('ar-EG'),
      type: 'success'
    });

    // إرسال التحديث اللحظي إلى قاعدة البيانات (فتظهر عند المستخدم فوراً)
    await supabase
      .from('tasks_queue')
      .update({
        completed_units: i,
        last_unit: `وحدة ${i}`,
        logs: currentLogs
      })
      .eq('id', task.id);

    console.log(`✅ مهمة #${task.id}: اكتمل ${i}/${task.total_units}`);
  }

  // إنهاء المهمة
  currentLogs.unshift({
    msg: 'اكتملت جميع المهام بنجاح على السيرفر!',
    time: new Date().toLocaleTimeString('ar-EG'),
    type: 'success'
  });

  await supabase
    .from('tasks_queue')
    .update({ status: 'completed', logs: currentLogs })
    .eq('id', task.id);

  console.log(`🎉 انتهت المهمة #${task.id} بالكامل.`);
}

// الاستماع اللحظي لأي مهمة جديدة تُضاف من الموقع
supabase
  .channel('tasks-channel')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'tasks_queue' }, (payload) => {
    if (payload.new && payload.new.status === 'pending') {
      processTask(payload.new);
    }
  })
  .subscribe();