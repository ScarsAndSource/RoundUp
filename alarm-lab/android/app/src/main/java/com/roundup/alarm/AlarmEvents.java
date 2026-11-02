package com.roundup.alarm;

import android.content.Context;
import android.content.SharedPreferences;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import org.json.JSONArray;

/**
 * Tiny persistent event log. Native code writes here even when the WebView is dead;
 * the JS side reads it with getEvents() and also gets live "alarmEvent" callbacks.
 */
final class AlarmEvents {
    private static final String PREFS = "roundup_events";
    private static final String KEY = "list";
    private static final int MAX = 100;

    private AlarmEvents() {}

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static void add(Context c, String type, String id, String phase) {
        JSObject e = new JSObject();
        e.put("type", type);
        e.put("id", id == null ? "" : id);
        e.put("phase", phase == null ? "" : phase);
        e.put("at", System.currentTimeMillis());

        synchronized (AlarmEvents.class) {
            try {
                JSONArray arr = new JSONArray(prefs(c).getString(KEY, "[]"));
                arr.put(e);
                JSONArray trimmed = new JSONArray();
                int start = Math.max(0, arr.length() - MAX);
                for (int i = start; i < arr.length(); i++) {
                    trimmed.put(arr.get(i));
                }
                prefs(c).edit().putString(KEY, trimmed.toString()).apply();
            } catch (Exception ignored) {
                // logging must never crash an alarm
            }
        }

        RoundupAlarmPlugin.emit(e);
    }

    static synchronized JSArray list(Context c) {
        try {
            return new JSArray(prefs(c).getString(KEY, "[]"));
        } catch (Exception ex) {
            return new JSArray();
        }
    }

    static synchronized void clear(Context c) {
        prefs(c).edit().putString(KEY, "[]").apply();
    }
}
