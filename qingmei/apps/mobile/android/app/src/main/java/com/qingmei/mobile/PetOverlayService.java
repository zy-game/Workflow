package com.qingmei.mobile;

import android.animation.ObjectAnimator;
import android.animation.PropertyValuesHolder;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import org.json.JSONArray;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

public class PetOverlayService extends Service {
    public static boolean running = false;
    private static final String SERVER = "https://139.155.78.241:8710";
    private final Handler handler = new Handler(Looper.getMainLooper());
    private WindowManager windowManager;
    private LinearLayout root;
    private ImageView petView;
    private TextView bubbleView;
    private WindowManager.LayoutParams params;
    private ObjectAnimator breath;
    private final Runnable hideBubbleTask = this::hideBubble;
    private volatile boolean stopped = false;
    private String lastMessage = "";
    private float downX;
    private float downY;
    private int startX;
    private int startY;
    private boolean moved;

    @Override
    public void onCreate() {
        super.onCreate();
        running = true;
        createChannel();
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(this, "qm_overlay")
            : new Notification.Builder(this);
        Notification notification = builder
            .setContentTitle("青梅")
            .setContentText("桌宠悬浮中")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .build();
        startForeground(41, notification);

        windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
        int petSize = Math.round(150 * getResources().getDisplayMetrics().density);
        int bubbleWidth = Math.round(220 * getResources().getDisplayMetrics().density);

        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setBackgroundColor(Color.TRANSPARENT);

        bubbleView = new TextView(this);
        bubbleView.setBackgroundResource(R.drawable.pet_bubble);
        bubbleView.setTextColor(Color.parseColor("#22302B"));
        bubbleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        bubbleView.setMaxLines(4);
        bubbleView.setMaxWidth(bubbleWidth);
        bubbleView.setVisibility(View.GONE);
        bubbleView.setOnClickListener((view) -> openChat());
        root.addView(bubbleView, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ));

        petView = new ImageView(this);
        petView.setImageResource(R.drawable.pet_alpha);
        petView.setBackgroundColor(Color.TRANSPARENT);
        petView.setScaleType(ImageView.ScaleType.FIT_CENTER);
        root.addView(petView, new LinearLayout.LayoutParams(petSize, petSize));

        params = new WindowManager.LayoutParams(
            Math.round(250 * getResources().getDisplayMetrics().density),
            WindowManager.LayoutParams.WRAP_CONTENT,
            Build.VERSION.SDK_INT >= 26
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        );
        params.gravity = Gravity.TOP | Gravity.START;
        params.x = 24;
        params.y = 240;

        petView.setOnTouchListener((view, event) -> {
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    downX = event.getRawX();
                    downY = event.getRawY();
                    startX = params.x;
                    startY = params.y;
                    moved = false;
                    return true;
                case MotionEvent.ACTION_MOVE:
                    int dx = Math.round(event.getRawX() - downX);
                    int dy = Math.round(event.getRawY() - downY);
                    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) moved = true;
                    params.x = startX + dx;
                    params.y = startY + dy;
                    windowManager.updateViewLayout(root, params);
                    return true;
                case MotionEvent.ACTION_UP:
                    if (!moved) openChat();
                    return true;
                default:
                    return false;
            }
        });

        windowManager.addView(root, params);

        breath = ObjectAnimator.ofPropertyValuesHolder(
            petView,
            PropertyValuesHolder.ofFloat(View.SCALE_X, 1f, 1.045f),
            PropertyValuesHolder.ofFloat(View.SCALE_Y, 1f, 1.045f),
            PropertyValuesHolder.ofFloat(View.TRANSLATION_Y, 0f, -5f)
        );
        breath.setDuration(1800);
        breath.setRepeatCount(ObjectAnimator.INFINITE);
        breath.setRepeatMode(ObjectAnimator.REVERSE);
        breath.start();

        new Thread(this::pollLoop, "qm-pet-bubble").start();
    }

    private void pollLoop() {
        while (!stopped) {
            try {
                Thread.sleep(8000);
                String text = fetchLatest();
                if (text != null && !text.isEmpty() && !text.equals(lastMessage)) {
                    lastMessage = text;
                    handler.post(() -> showBubble(text));
                }
            } catch (InterruptedException ignored) {
                return;
            } catch (Exception ignored) {
                // 网络失败下一轮再试
            }
        }
    }

    private String fetchLatest() throws Exception {
        SharedPreferences prefs;
        try {
            MasterKey key = new MasterKey.Builder(this)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build();
            prefs = EncryptedSharedPreferences.create(
                this,
                "qm_secure",
                key,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            );
        } catch (Exception error) {
            return null;
        }
        String token = prefs.getString("qm.token", null);
        if (token == null || token.isEmpty()) return null;
        HttpURLConnection connection = (HttpURLConnection) new URL(
            SERVER + "/api/v1/messages?conversationId=owner&limit=1"
        ).openConnection();
        connection.setConnectTimeout(6000);
        connection.setReadTimeout(6000);
        connection.setRequestProperty("Authorization", "Bearer " + token);
        connection.setRequestProperty("Accept", "application/json");
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), "UTF-8"))) {
            StringBuilder text = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) text.append(line);
            JSONArray rows = new JSONArray(text.toString());
            if (rows.length() == 0) return null;
            return rows.getJSONObject(0).optString("text", "");
        } finally {
            connection.disconnect();
        }
    }

    private void showBubble(String text) {
        bubbleView.setText(text.length() > 120 ? text.substring(0, 120) + "…" : text);
        bubbleView.setVisibility(View.VISIBLE);
        if (params != null) windowManager.updateViewLayout(root, params);
        handler.removeCallbacks(hideBubbleTask);
        handler.postDelayed(hideBubbleTask, 12000);
    }

    private void hideBubble() {
        if (bubbleView != null) bubbleView.setVisibility(View.GONE);
    }

    private void openChat() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        intent.putExtra("open_chat", true);
        startActivity(intent);
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        NotificationChannel channel = new NotificationChannel("qm_overlay", "桌宠悬浮", NotificationManager.IMPORTANCE_LOW);
        manager.createNotificationChannel(channel);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && root != null) {
            String action = intent.getAction();
            if ("hide".equals(action)) root.setVisibility(View.GONE);
            if ("show".equals(action)) root.setVisibility(View.VISIBLE);
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopped = true;
        running = false;
        if (breath != null) breath.cancel();
        handler.removeCallbacksAndMessages(null);
        if (root != null && windowManager != null) {
            try {
                windowManager.removeView(root);
            } catch (Exception ignored) {
            }
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
