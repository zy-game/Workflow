package com.qingmei.mobile;

import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "PetOverlay")
public class PetOverlayPlugin extends Plugin {
    @PluginMethod
    public void canDraw(PluginCall call) {
        call.resolve(new JSObject().put("granted", Settings.canDrawOverlays(getContext())));
    }

    @PluginMethod
    public void isRunning(PluginCall call) {
        call.resolve(new JSObject().put("running", PetOverlayService.running));
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent intent = new Intent(
            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
            Uri.parse("package:" + getContext().getPackageName())
        );
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (!Settings.canDrawOverlays(getContext())) {
            call.reject("需要悬浮窗权限");
            return;
        }
        ContextCompat.startForegroundService(getContext(), new Intent(getContext(), PetOverlayService.class));
        if (getActivity() != null) getActivity().moveTaskToBack(true);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), PetOverlayService.class));
        call.resolve();
    }
}
