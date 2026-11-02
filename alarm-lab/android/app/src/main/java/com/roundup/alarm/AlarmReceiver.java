package com.roundup.alarm;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import androidx.core.content.ContextCompat;

/** Fired by AlarmManager at the exact alarm time. Hands over to the foreground service. */
public class AlarmReceiver extends BroadcastReceiver {
    private static final String TAG = "RoundupAlarm";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !AlarmScheduler.ACTION_FIRE.equals(intent.getAction())) return;

        String id = intent.getStringExtra(AlarmScheduler.EXTRA_ID);
        String phase = intent.getStringExtra(AlarmScheduler.EXTRA_PHASE);
        String label = intent.getStringExtra(AlarmScheduler.EXTRA_LABEL);
        if (id == null) return;
        if (phase == null) phase = "RING";
        if (label == null) label = "";

        AlarmStore.remove(context, id); // one-shot: it has fired
        AlarmEvents.add(context, "fired", id, phase);

        Intent svc = new Intent(context, AlarmService.class);
        svc.setAction(AlarmService.ACTION_START);
        svc.putExtra(AlarmScheduler.EXTRA_ID, id);
        svc.putExtra(AlarmScheduler.EXTRA_PHASE, phase);
        svc.putExtra(AlarmScheduler.EXTRA_LABEL, label);

        try {
            ContextCompat.startForegroundService(context, svc);
        } catch (Exception e) {
            Log.e(TAG, "could not start AlarmService, using notification fallback", e);
            AlarmEvents.add(context, "service_start_failed", id, phase);
            AlarmNotifications.postRinging(context, id, phase, label);
        }
    }
}
