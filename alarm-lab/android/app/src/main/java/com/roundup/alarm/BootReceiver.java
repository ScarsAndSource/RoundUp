package com.roundup.alarm;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * AlarmManager forgets all alarms on reboot, so re-arm them from AlarmStore. Also runs after
 * an app update and when the user grants/revokes the exact-alarm permission.
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        String a = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(a)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)
                || "android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED".equals(a)) {
            AlarmScheduler.rescheduleAll(context);
            AlarmEvents.add(context, "rescheduled", "", a);
        }
    }
}
