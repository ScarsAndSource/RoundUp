package com.roundup.alarm;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextClock;
import android.widget.TextView;
import android.widget.Toast;

/**
 * Full-screen alarm UI shown over the lock screen. Built in code (no XML) on purpose.
 *  RING  phase: big "I'M AWAKE" button -> stops the sound, arms the CHECK alarm 2 min later.
 *  CHECK phase: hold the button for 3 s -> confirmed.
 */
public class AlarmActivity extends Activity {
    private static final long HOLD_MS = 3000L;

    private String id = "";
    private String phase = "RING";
    private String label = "";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private Button button;
    private long holdStart;

    private final Runnable holdTick = new Runnable() {
        @Override
        public void run() {
            long elapsed = SystemClock.uptimeMillis() - holdStart;
            if (elapsed >= HOLD_MS) {
                onConfirmed();
                return;
            }
            long left = (HOLD_MS - elapsed + 999) / 1000;
            if (button != null) button.setText("KEEP HOLDING… " + left);
            handler.postDelayed(this, 100);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        showOverLockScreen();
        readIntent(getIntent());
        render();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        readIntent(intent);
        render();
    }

    @SuppressWarnings("deprecation")
    private void showOverLockScreen() {
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(
                    WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                            | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    private void readIntent(Intent intent) {
        String i = intent.getStringExtra(AlarmScheduler.EXTRA_ID);
        String p = intent.getStringExtra(AlarmScheduler.EXTRA_PHASE);
        String l = intent.getStringExtra(AlarmScheduler.EXTRA_LABEL);
        id = i == null ? "" : i;
        phase = p == null ? "RING" : p;
        label = l == null ? "" : l;
    }

    private int dp(float v) {
        return (int) TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    private void render() {
        handler.removeCallbacks(holdTick);
        boolean check = "CHECK".equals(phase);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setBackgroundColor(Color.BLACK);
        root.setPadding(dp(24), dp(24), dp(24), dp(24));

        TextClock clock = new TextClock(this);
        clock.setFormat12Hour("h:mm");
        clock.setFormat24Hour("HH:mm");
        clock.setTextColor(Color.WHITE);
        clock.setTextSize(TypedValue.COMPLEX_UNIT_SP, 72);
        clock.setGravity(Gravity.CENTER);
        root.addView(clock);

        TextView title = new TextView(this);
        title.setText(check ? "STILL AWAKE?" : "WAKE UP");
        title.setTextColor(check ? Color.parseColor("#F5A623") : Color.parseColor("#FF5252"));
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 30);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setGravity(Gravity.CENTER);
        title.setPadding(0, dp(8), 0, dp(8));
        root.addView(title);

        TextView sub = new TextView(this);
        String hint = check
                ? "Hold the button for 3 seconds to prove it."
                : "Tap when you are really awake. A second check follows in 2 minutes.";
        sub.setText(label.isEmpty() ? hint : label + "\n\n" + hint);
        sub.setTextColor(Color.parseColor("#B0B0B0"));
        sub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        sub.setGravity(Gravity.CENTER);
        sub.setPadding(0, 0, 0, dp(32));
        root.addView(sub);

        button = new Button(this);
        button.setText(check ? "HOLD TO CONFIRM" : "I'M AWAKE");
        button.setTextColor(Color.WHITE);
        button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        button.setTypeface(Typeface.DEFAULT_BOLD);
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(20));
        bg.setColor(check ? Color.parseColor("#F5A623") : Color.parseColor("#2E7D32"));
        button.setBackground(bg);
        root.addView(button, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(110)));

        if (check) {
            button.setOnTouchListener((v, ev) -> {
                switch (ev.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        holdStart = SystemClock.uptimeMillis();
                        handler.removeCallbacks(holdTick);
                        handler.post(holdTick);
                        return true;
                    case MotionEvent.ACTION_UP:
                    case MotionEvent.ACTION_CANCEL:
                        handler.removeCallbacks(holdTick);
                        button.setText("HOLD TO CONFIRM");
                        return true;
                    default:
                        return true;
                }
            });
        } else {
            button.setOnClickListener(v -> onAwakeTapped());
        }

        setContentView(root);
    }

    private void onAwakeTapped() {
        stopService(new Intent(this, AlarmService.class));
        AlarmEvents.add(this, "awake_tapped", id, "RING");

        String checkId = id + ":check";
        long at = System.currentTimeMillis() + AlarmScheduler.CHECK_DELAY_MS;
        try {
            AlarmScheduler.schedule(this, new AlarmStore.Record(checkId, at, "CHECK", label));
            AlarmEvents.add(this, "check_scheduled", checkId, "CHECK");
            Toast.makeText(this, "Stay awake — second check in 2 minutes", Toast.LENGTH_LONG).show();
        } catch (Exception e) {
            AlarmEvents.add(this, "check_schedule_failed", checkId, "CHECK");
            Toast.makeText(this, "Could not schedule the second check", Toast.LENGTH_LONG).show();
        }
        finish();
    }

    private void onConfirmed() {
        handler.removeCallbacks(holdTick);
        stopService(new Intent(this, AlarmService.class));
        AlarmEvents.add(this, "confirmed", id, "CHECK");
        Toast.makeText(this, "Confirmed — you're up!", Toast.LENGTH_LONG).show();
        finish();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // Intentionally ignored: the user has to pick an action. (Home still works; the
        // service stops itself after 10 minutes and the server escalates to friends.)
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }
}
