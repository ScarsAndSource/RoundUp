package com.roundup.alarm;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

/** Arms / cancels alarms with AlarmManager.setAlarmClock (the most Doze-proof option). */
final class AlarmScheduler {
    private static final String TAG = "RoundupAlarm";

    static final String ACTION_FIRE = "com.roundup.alarm.ACTION_FIRE";
    static final String EXTRA_ID = "alarm_id";
    static final String EXTRA_PHASE = "alarm_phase";
    static final String EXTRA_LABEL = "alarm_label";

    /** Gap between the first "I'm awake" tap and the second proof. Keep in sync with the server rule. */
    static final long CHECK_DELAY_MS = 2 * 60 * 1000L;

    /** If the phone was off at alarm time, only still notify when it is at most this late. */
    private static final long MISSED_WINDOW_MS = 15 * 60 * 1000L;

    private AlarmScheduler() {}

    static boolean canScheduleExact(Context c) {
        if (Build.VERSION.SDK_INT < 31) return true;
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        return am != null && am.canScheduleExactAlarms();
    }

    private static PendingIntent operation(Context c, String id, String phase, String label) {
        Intent i = new Intent(c, AlarmReceiver.class);
        i.setAction(ACTION_FIRE);
        // Unique data URI => one distinct PendingIntent per alarm id
        i.setData(Uri.parse("roundup://alarm/" + Uri.encode(id)));
        i.putExtra(EXTRA_ID, id);
        i.putExtra(EXTRA_PHASE, phase);
        i.putExtra(EXTRA_LABEL, label);
        return PendingIntent.getBroadcast(
                c, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static PendingIntent showIntent(Context c) {
        Intent i = new Intent(c, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(
                c, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Throws SecurityException if exact alarms are not allowed. */
    static void schedule(Context c, AlarmStore.Record r) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am == null) throw new IllegalStateException("AlarmManager unavailable");
        AlarmStore.put(c, r);
        try {
            am.setAlarmClock(
                    new AlarmManager.AlarmClockInfo(r.triggerAtMillis, showIntent(c)),
                    operation(c, r.id, r.phase, r.label));
        } catch (RuntimeException e) {
            AlarmStore.remove(c, r.id);
            throw e;
        }
    }

    static void cancel(Context c, String id) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am != null) am.cancel(operation(c, id, "RING", ""));
        AlarmStore.remove(c, id);
    }

    static void cancelAll(Context c) {
        for (AlarmStore.Record r : AlarmStore.all(c)) {
            cancel(c, r.id);
        }
    }

    /** Re-arm everything after a reboot / app update / permission change. */
    static void rescheduleAll(Context c) {
        long now = System.currentTimeMillis();
        for (AlarmStore.Record r : AlarmStore.all(c)) {
            if (r.triggerAtMillis > now + 1000) {
                try {
                    schedule(c, r);
                } catch (RuntimeException e) {
                    Log.w(TAG, "could not re-arm " + r.id, e);
                    AlarmEvents.add(c, "rearm_failed", r.id, r.phase);
                }
            } else {
                AlarmStore.remove(c, r.id);
                if (now - r.triggerAtMillis <= MISSED_WINDOW_MS) {
                    AlarmNotifications.postRinging(c, r.id, r.phase, r.label);
                    AlarmEvents.add(c, "missed_while_off", r.id, r.phase);
                }
            }
        }
    }
}
