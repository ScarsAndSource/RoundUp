package com.roundup.alarm;

import android.app.Notification;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Log;

/**
 * Plays the alarm loudly on the ALARM audio stream, vibrates, holds a wake lock and shows the
 * full-screen alarm UI via a notification. Runs as a mediaPlayback foreground service.
 * Stop it with stopService() (AlarmActivity and the plugin both do that).
 */
public class AlarmService extends Service {
    private static final String TAG = "RoundupAlarm";

    static final String ACTION_START = "com.roundup.alarm.ACTION_START_RINGING";

    /** The alarm gives up by itself after this long (the server escalates to friends anyway). */
    private static final long MAX_RING_MS = 10 * 60 * 1000L;

    /** Force the alarm stream to max volume while ringing. */
    private static final boolean FORCE_MAX_VOLUME = true;

    private MediaPlayer player;
    private Vibrator vibrator;
    private PowerManager.WakeLock wakeLock;
    private final Handler handler = new Handler(Looper.getMainLooper());

    private String currentId = "";
    private String currentPhase = "RING";

    private final Runnable autoStop = new Runnable() {
        @Override
        public void run() {
            AlarmEvents.add(AlarmService.this, "ring_timeout", currentId, currentPhase);
            stopSelf();
        }
    };

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String id = intent != null ? intent.getStringExtra(AlarmScheduler.EXTRA_ID) : null;
        String phase = intent != null ? intent.getStringExtra(AlarmScheduler.EXTRA_PHASE) : null;
        String label = intent != null ? intent.getStringExtra(AlarmScheduler.EXTRA_LABEL) : null;

        if (id == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        currentId = id;
        currentPhase = phase == null ? "RING" : phase;

        AlarmNotifications.ensureChannels(this);
        Notification n = AlarmNotifications.buildRinging(
                this, id, currentPhase, label, AlarmNotifications.CH_SILENT);

        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(
                        AlarmNotifications.ID_RINGING, n,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(AlarmNotifications.ID_RINGING, n);
            }
        } catch (Exception e) {
            Log.e(TAG, "startForeground failed", e);
            AlarmEvents.add(this, "foreground_failed", id, currentPhase);
            AlarmNotifications.postRinging(this, id, currentPhase, label);
            stopSelf();
            return START_NOT_STICKY;
        }

        stopRinging(); // reset if a second alarm starts while one is already ringing
        acquireWakeLock();
        startSound();
        startVibration();

        handler.removeCallbacks(autoStop);
        handler.postDelayed(autoStop, MAX_RING_MS);

        AlarmEvents.add(this, "ringing", id, currentPhase);
        return START_NOT_STICKY;
    }

    private void acquireWakeLock() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "roundup:alarm");
                wakeLock.acquire(MAX_RING_MS + 30_000L);
            }
        } catch (Exception e) {
            Log.w(TAG, "wake lock failed", e);
        }
    }

    private void startSound() {
        try {
            if (FORCE_MAX_VOLUME) {
                AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
                if (am != null) {
                    try {
                        am.setStreamVolume(
                                AudioManager.STREAM_ALARM,
                                am.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0);
                    } catch (SecurityException ignored) {
                        // some DND setups refuse volume changes; keep going with current volume
                    }
                }
            }

            Uri uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
            if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);

            MediaPlayer mp = new MediaPlayer();
            mp.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build());
            mp.setDataSource(this, uri);
            mp.setLooping(true);
            mp.prepare();
            mp.start();
            player = mp;
        } catch (Exception e) {
            Log.e(TAG, "sound failed", e);
            player = null;
            AlarmEvents.add(this, "sound_failed", currentId, currentPhase);
        }
    }

    @SuppressWarnings("deprecation")
    private void startVibration() {
        try {
            vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            if (vibrator == null || !vibrator.hasVibrator()) return;
            long[] pattern = {0, 800, 600};
            if (Build.VERSION.SDK_INT >= 26) {
                AudioAttributes aa = new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build();
                vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0), aa);
            } else {
                vibrator.vibrate(pattern, 0);
            }
        } catch (Exception e) {
            Log.w(TAG, "vibration failed", e);
        }
    }

    private void stopRinging() {
        try {
            if (player != null) {
                try {
                    if (player.isPlaying()) player.stop();
                } catch (IllegalStateException ignored) {
                    // already stopped
                }
                player.release();
            }
        } catch (Exception ignored) {
            // best effort
        }
        player = null;

        try {
            if (vibrator != null) vibrator.cancel();
        } catch (Exception ignored) {
            // best effort
        }

        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Exception ignored) {
            // best effort
        }
        wakeLock = null;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(autoStop);
        stopRinging();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
