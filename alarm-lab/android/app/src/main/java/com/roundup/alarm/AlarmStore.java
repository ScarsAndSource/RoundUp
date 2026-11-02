package com.roundup.alarm;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Persisted list of scheduled alarms. AlarmManager forgets every alarm on reboot,
 * so BootReceiver re-arms them from here.
 */
final class AlarmStore {
    private static final String PREFS = "roundup_alarms";
    private static final String KEY = "list";

    static final class Record {
        final String id;
        final long triggerAtMillis;
        final String phase; // "RING" (first wake-up) or "CHECK" (second proof)
        final String label;

        Record(String id, long triggerAtMillis, String phase, String label) {
            this.id = id;
            this.triggerAtMillis = triggerAtMillis;
            this.phase = phase == null ? "RING" : phase;
            this.label = label == null ? "" : label;
        }
    }

    private AlarmStore() {}

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static synchronized List<Record> all(Context c) {
        List<Record> out = new ArrayList<>();
        try {
            JSONArray arr = new JSONArray(prefs(c).getString(KEY, "[]"));
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                out.add(new Record(
                        o.optString("id"),
                        o.optLong("t"),
                        o.optString("phase", "RING"),
                        o.optString("label", "")));
            }
        } catch (Exception ignored) {
            // corrupt data -> treat as empty
        }
        return out;
    }

    private static void save(Context c, List<Record> list) {
        JSONArray arr = new JSONArray();
        for (Record r : list) {
            try {
                JSONObject o = new JSONObject();
                o.put("id", r.id);
                o.put("t", r.triggerAtMillis);
                o.put("phase", r.phase);
                o.put("label", r.label);
                arr.put(o);
            } catch (Exception ignored) {
                // skip a record we cannot serialise
            }
        }
        prefs(c).edit().putString(KEY, arr.toString()).apply();
    }

    static synchronized void put(Context c, Record r) {
        List<Record> list = all(c);
        List<Record> next = new ArrayList<>();
        for (Record x : list) {
            if (!x.id.equals(r.id)) next.add(x);
        }
        next.add(r);
        save(c, next);
    }

    static synchronized Record remove(Context c, String id) {
        List<Record> list = all(c);
        List<Record> next = new ArrayList<>();
        Record removed = null;
        for (Record x : list) {
            if (x.id.equals(id)) removed = x;
            else next.add(x);
        }
        if (removed != null) save(c, next);
        return removed;
    }
}
