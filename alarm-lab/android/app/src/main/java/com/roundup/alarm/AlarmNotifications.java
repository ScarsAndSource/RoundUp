package com.roundup.alarm;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/** Notification channels + the full-screen "alarm ringing" notification. */
final class AlarmNotifications {
    /** Used by AlarmService: the service plays the sound itself, so the channel is silent. */
    static final String CH_SILENT = "roundup_alarm_silent_v1";
    /** Fallback when the service cannot start: the notification itself plays the alarm sound. */
    static final String CH_LOUD = "roundup_alarm_loud_v1";

    static final int ID_RINGING = 4242;

    private AlarmNotifications() {}

    static void ensureChannels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;

        NotificationChannel silent = new NotificationChannel(
                CH_SILENT, "Alarm screen", NotificationManager.IMPORTANCE_HIGH);
        silent.setDescription("Shows the full-screen wake-up screen");
        silent.setSound(null, null);
        silent.enableVibration(false);
        silent.setBypassDnd(true);
        silent.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(silent);

        NotificationChannel loud = new NotificationChannel(
                CH_LOUD, "Alarm (fallback)", NotificationManager.IMPORTANCE_HIGH);
        loud.setDescription("Used if the alarm service could not start");
        Uri alarmUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
        AudioAttributes aa = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
        loud.setSound(alarmUri, aa);
        loud.enableVibration(true);
        loud.setVibrationPattern(new long[]{0, 800, 600, 800, 600, 800});
        loud.setBypassDnd(true);
        loud.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(loud);
    }

    static Notification buildRinging(
            Context c, String id, String phase, String label, String channel) {
        Intent a = new Intent(c, AlarmActivity.class);
        a.putExtra(AlarmScheduler.EXTRA_ID, id);
        a.putExtra(AlarmScheduler.EXTRA_PHASE, phase);
        a.putExtra(AlarmScheduler.EXTRA_LABEL, label);
        a.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(
                c, 1, a, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        boolean check = "CHECK".equals(phase);
        String text = (label == null || label.isEmpty())
                ? (check ? "Hold the button to confirm you're awake" : "Tap to open the alarm")
                : label;

        return new NotificationCompat.Builder(c, channel)
                .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                .setContentTitle(check ? "Prove you're awake" : "Wake up!")
                .setContentText(text)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setOngoing(true)
                .setAutoCancel(false)
                .setContentIntent(pi)
                .setFullScreenIntent(pi, true)
                .build();
    }

    /** Posts a loud, full-screen-capable notification WITHOUT the foreground service. */
    static void postRinging(Context c, String id, String phase, String label) {
        if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(c, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        ensureChannels(c);
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        nm.notify(ID_RINGING, buildRinging(c, id, phase, label, CH_LOUD));
    }
}
