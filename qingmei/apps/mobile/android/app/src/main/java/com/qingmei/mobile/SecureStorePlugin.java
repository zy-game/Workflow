package com.qingmei.mobile;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "SecureStore")
public class SecureStorePlugin extends Plugin {
    private SharedPreferences prefs;

    @Override
    public void load() {
        try {
            Context context = getContext();
            MasterKey key = new MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build();
            prefs = EncryptedSharedPreferences.create(
                context,
                "qm_secure",
                key,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            );
        } catch (Exception error) {
            prefs = null;
        }
    }

    @PluginMethod
    public void get(PluginCall call) {
        String key = call.getString("key");
        if (key == null || prefs == null) {
            call.resolve(new JSObject().put("value", null));
            return;
        }
        call.resolve(new JSObject().put("value", prefs.getString(key, null)));
    }

    @PluginMethod
    public void set(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");
        if (key == null || value == null || prefs == null) {
            call.reject("secure storage unavailable");
            return;
        }
        prefs.edit().putString(key, value).apply();
        call.resolve();
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String key = call.getString("key");
        if (key != null && prefs != null) prefs.edit().remove(key).apply();
        call.resolve();
    }
}
