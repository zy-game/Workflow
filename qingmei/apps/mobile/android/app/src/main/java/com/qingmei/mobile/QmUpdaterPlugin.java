package com.qingmei.mobile;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/**
 * Android 应用内更新：返回当前版本、下载新 APK 并拉起系统安装。
 * JS 侧只负责比对 latest.json 与提示；下载、校验、安装都在原生完成。
 */
@CapacitorPlugin(name = "QmUpdater")
public class QmUpdaterPlugin extends Plugin {
    @PluginMethod
    public void getInfo(PluginCall call) {
        try {
            PackageInfo info = getContext()
                .getPackageManager()
                .getPackageInfo(getContext().getPackageName(), 0);
            long code = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? info.getLongVersionCode()
                : info.versionCode;
            JSObject ret = new JSObject();
            ret.put("versionName", info.versionName);
            ret.put("versionCode", code);
            call.resolve(ret);
        } catch (Exception error) {
            call.reject(messageOf(error));
        }
    }

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        final String url = call.getString("url");
        final String expected = call.getString("sha256");
        if (url == null || url.isEmpty()) {
            call.reject("缺少下载地址");
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent settings = new Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + getContext().getPackageName())
            );
            settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(settings);
            call.reject("请先允许「安装未知应用」，再回来点更新");
            return;
        }

        toast("正在下载更新…");
        new Thread(() -> {
            try {
                File dir = new File(getContext().getCacheDir(), "updates");
                if (!dir.exists() && !dir.mkdirs()) throw new Exception("无法创建缓存目录");
                File apk = new File(dir, "qingmei-update.apk");

                HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(60000);
                connection.setInstanceFollowRedirects(true);
                connection.connect();
                try {
                    int code = connection.getResponseCode();
                    if (code != HttpURLConnection.HTTP_OK) {
                        throw new Exception("下载失败（HTTP " + code + "）");
                    }
                    try (InputStream in = connection.getInputStream();
                         FileOutputStream out = new FileOutputStream(apk)) {
                        byte[] buffer = new byte[8192];
                        int read;
                        while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
                    }
                } finally {
                    connection.disconnect();
                }

                if (expected != null && !expected.isEmpty()) {
                    String actual = sha256(apk);
                    if (!actual.equalsIgnoreCase(expected)) {
                        apk.delete();
                        throw new Exception("安装包校验失败，请重试");
                    }
                }

                Uri uri = FileProvider.getUriForFile(
                    getContext(),
                    getContext().getPackageName() + ".fileprovider",
                    apk
                );
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(uri, "application/vnd.android.package-archive");
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);

                getActivity().runOnUiThread(() -> {
                    try {
                        getContext().startActivity(intent);
                        call.resolve();
                    } catch (Exception error) {
                        call.reject("无法拉起安装器：" + messageOf(error));
                    }
                });
            } catch (Exception error) {
                getActivity().runOnUiThread(() -> call.reject(messageOf(error)));
            }
        }).start();
    }

    private void toast(String text) {
        getActivity().runOnUiThread(() ->
            Toast.makeText(getContext(), text, Toast.LENGTH_SHORT).show()
        );
    }

    private static String messageOf(Exception error) {
        String message = error.getMessage();
        return message == null || message.isEmpty() ? "更新失败" : message;
    }

    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) > 0) digest.update(buffer, 0, read);
        }
        StringBuilder hex = new StringBuilder();
        for (byte value : digest.digest()) hex.append(String.format("%02x", value));
        return hex.toString();
    }
}
