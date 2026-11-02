package com.roundup.alarm;

import android.Manifest;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * JS bridge. From JS:  const A = Capacitor.registerPlugin('RoundupAlarm');
 *   A.status()  A.requestNotifications()  A.openSettings({type})
 *   A.schedule({id, triggerAtMillis, phase?, label?})  A.cancel({id})  A.cancelAll()
 *   A.listAlarms()  A.stopAlarm()  A.getEvents()  A.clearEvents()
 *   A.addListener('alarmEvent', cb)
 */
@CapacitorPlugin(
        name = "RoundupAlarm",
        permissions = {
                @Permission(strings = {Manifest.permission.POST_NOTIFICATIONS}, alias = "notifications")
        })
public class RoundupAlarmPlugin extends Plugin {

    private static RoundupAlarmPlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) instance = null;
    }

    /** Called from native code (receiver / service / activity) to push a live event to JS. */
    static void emit(JSObject event) {
        RoundupAlarmPlugin p = instance;
        if (p == null) return;
        try {
            p.notifyListeners("alarmEvent", event, true);
        } catch (Exception ignored) {
            // the persisted log still has it
        }
    }

    // ---------------------------------------------------------------- status

    private boolean canUseFullScreenIntent(Context c) {
        if (Build.VERSION.SDK_INT >= 34) {
            NotificationManager nm = c.getSystemService(NotificationManager.class);
            return nm != null && nm.canUseFullScreenIntent();
        }
        return true;
    }

    private boolean isIgnoringBatteryOptimizations(Context c) {
        PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(c.getPackageName());
    }

    private JSObject statusObject() {
        Context c = getContext();
        JSObject o = new JSObject();
        o.put("sdkInt", Build.VERSION.SDK_INT);
        o.put("manufacturer", Build.MANUFACTURER);
        o.put("model", Build.MODEL);
        o.put("canScheduleExactAlarms", AlarmScheduler.canScheduleExact(c));
        o.put("notificationsEnabled", NotificationManagerCompat.from(c).areNotificationsEnabled());
        o.put("canUseFullScreenIntent", canUseFullScreenIntent(c));
        o.put("ignoringBatteryOptimizations", isIgnoringBatteryOptimizations(c));
        return o;
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(statusObject());
    }

    // ---------------------------------------------------------------- permissions

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33
                || getPermissionState("notifications") == PermissionState.GRANTED) {
            call.resolve(statusObject());
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationsCallback");
    }

    @PermissionCallback
    private void notificationsCallback(PluginCall call) {
        call.resolve(statusObject());
    }

    private Intent appDetails(String pkg) {
        return new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + pkg));
    }

    private Intent notificationSettings(String pkg) {
        Intent i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
        i.putExtra(Settings.EXTRA_APP_PACKAGE, pkg);
        return i;
    }

    /** type: exactAlarm | fullScreenIntent | battery | notifications | app */
    @PluginMethod
    public void openSettings(PluginCall call) {
        String type = call.getString("type", "app");
        String pkg = getContext().getPackageName();
        Intent i;
        switch (type) {
            case "exactAlarm":
                i = Build.VERSION.SDK_INT >= 31
                        ? new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:" + pkg))
                        : appDetails(pkg);
                break;
            case "fullScreenIntent":
                i = Build.VERSION.SDK_INT >= 34
                        ? new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + pkg))
                        : notificationSettings(pkg);
                break;
            case "battery":
                i = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                break;
            case "notifications":
                i = notificationSettings(pkg);
                break;
            default:
                i = appDetails(pkg);
                break;
        }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(i);
        } catch (Exception first) {
            try {
                Intent fallback = appDetails(pkg);
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallback);
            } catch (Exception second) {
                call.reject("Could not open settings");
                return;
            }
        }
        call.resolve();
    }

    // ---------------------------------------------------------------- alarms

    @PluginMethod
    public void schedule(PluginCall call) {
        String id = call.getString("id");
        Double t = call.getDouble("triggerAtMillis");
        if (id == null || id.isEmpty() || t == null) {
            call.reject("id and triggerAtMillis are required");
            return;
        }
        long triggerAt = t.longValue();
        String phase = call.getString("phase", "RING");
        String label = call.getString("label", "");

        if (!"RING".equals(phase) && !"CHECK".equals(phase)) {
            call.reject("phase must be RING or CHECK");
            return;
        }
        if (triggerAt < System.currentTimeMillis() + 3000) {
            call.reject("triggerAtMillis must be at least 3 seconds in the future");
            return;
        }
        if (!AlarmScheduler.canScheduleExact(getContext())) {
            call.reject("Exact alarm permission missing", "EXACT_ALARM_PERMISSION_MISSING");
            return;
        }
        try {
            AlarmScheduler.schedule(getContext(), new AlarmStore.Record(id, triggerAt, phase, label));
            AlarmEvents.add(getContext(), "scheduled", id, phase);
        } catch (Exception e) {
            call.reject("Could not schedule: " + e.getMessage());
            return;
        }
        JSObject ret = new JSObject();
        ret.put("id", id);
        ret.put("triggerAtMillis", triggerAt);
        call.resolve(ret);
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("id");
        if (id == null || id.isEmpty()) {
            call.reject("id is required");
            return;
        }
        AlarmScheduler.cancel(getContext(), id);
        AlarmEvents.add(getContext(), "cancelled", id, "");
        call.resolve();
    }

    @PluginMethod
    public void cancelAll(PluginCall call) {
        AlarmScheduler.cancelAll(getContext());
        AlarmEvents.add(getContext(), "cancelled_all", "", "");
        call.resolve();
    }

    @PluginMethod
    public void listAlarms(PluginCall call) {
        JSArray arr = new JSArray();
        for (AlarmStore.Record r : AlarmStore.all(getContext())) {
            JSObject o = new JSObject();
            o.put("id", r.id);
            o.put("triggerAtMillis", r.triggerAtMillis);
            o.put("phase", r.phase);
            o.put("label", r.label);
            arr.put(o);
        }
        JSObject ret = new JSObject();
        ret.put("alarms", arr);
        call.resolve(ret);
    }

    @PluginMethod
    public void stopAlarm(PluginCall call) {
        getContext().stopService(new Intent(getContext(), AlarmService.class));
        call.resolve();
    }

    // ---------------------------------------------------------------- event log

    @PluginMethod
    public void getEvents(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("events", AlarmEvents.list(getContext()));
        call.resolve(ret);
    }

    @PluginMethod
    public void clearEvents(PluginCall call) {
        AlarmEvents.clear(getContext());
        call.resolve();
    }
}
