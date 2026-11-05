package com.qingmei.mobile;

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
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import org.json.JSONArray;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Random;

import pl.droidsonroids.gif.GifImageView;

public class PetOverlayService extends Service {
    public static boolean running = false;
    private static final String SERVER = "https://139.155.78.241:8710";
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Random random = new Random();
    private final Runnable hideBubbleTask = this::hideBubble;
    private final Runnable singleTapTask = this::onSingleTap;
    private WindowManager windowManager;
    private GifImageView petView;
    private TextView bubbleView;
    private LinearLayout menuView;
    private WindowManager.LayoutParams petParams;
    private WindowManager.LayoutParams bubbleParams;
    private WindowManager.LayoutParams menuParams;
    private volatile boolean stopped = false;
    private boolean quiet = false;
    private boolean sleeping = false;
    private long lastInteraction = System.currentTimeMillis();
    private long lastTapAt = 0;
    private String lastMessage = "";
    private float downX;
    private float downY;
    private int startX;
    private int startY;
    private long downAt;
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
        int petSize = dp(150);

        petView = new GifImageView(this);
        petView.setImageResource(R.raw.idle_breath);
        petView.setBackgroundColor(Color.TRANSPARENT);

        petParams = new WindowManager.LayoutParams(
            petSize,
            petSize,
            Build.VERSION.SDK_INT >= 26
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        );
        petParams.gravity = Gravity.TOP | Gravity.START;
        petParams.x = dp(20);
        petParams.y = dp(200);

        petView.setOnTouchListener((view, event) -> {
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    wake();
                    downX = event.getRawX();
                    downY = event.getRawY();
                    startX = petParams.x;
                    startY = petParams.y;
                    downAt = System.currentTimeMillis();
                    moved = false;
                    return true;
                case MotionEvent.ACTION_MOVE:
                    int dx = Math.round(event.getRawX() - downX);
                    int dy = Math.round(event.getRawY() - downY);
                    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) moved = true;
                    petParams.x = startX + dx;
                    petParams.y = startY + dy;
                    windowManager.updateViewLayout(petView, petParams);
                    return true;
                case MotionEvent.ACTION_UP:
                    if (moved) {
                        hideBubble();
                        hideMenu();
                        return true;
                    }
                    if (System.currentTimeMillis() - downAt >= 450) {
                        toggleMenu();
                    } else {
                        handleTap();
                    }
                    return true;
                default:
                    return false;
            }
        });

        windowManager.addView(petView, petParams);
        buildBubble();
        buildMenu();
        new Thread(this::pollLoop, "qm-pet-bubble").start();
        handler.postDelayed(this::idleTick, 20000);
    }

    private void buildBubble() {
        bubbleView = new TextView(this);
        bubbleView.setBackgroundResource(R.drawable.pet_bubble);
        bubbleView.setTextColor(Color.parseColor("#22302B"));
        bubbleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        bubbleView.setMaxLines(4);
        bubbleView.setVisibility(View.GONE);
        bubbleView.setOnClickListener((view) -> openChat());
    }

    private void buildMenu() {
        menuView = new LinearLayout(this);
        menuView.setOrientation(LinearLayout.VERTICAL);
        menuView.setBackgroundResource(R.drawable.pet_bubble);
        menuView.setPadding(dp(8), dp(8), dp(8), dp(8));
        menuView.addView(menuButton("摸摸头", () -> play(R.raw.click_happy, "摸摸头～")));
        menuView.addView(menuButton("喂饭", () -> feed()));
        menuView.addView(menuButton("逗一下", () -> play(randomClick(), "嘿嘿。")));
        menuView.addView(menuButton("照镜子", () -> play(R.raw.fun_mirror, "今天的头发也很乖。")));
        menuView.addView(menuButton("蓝鲸现世", () -> play(R.raw.fun_whale, "看，鲸鱼。")));
        menuView.addView(menuButton("玩水枪", () -> play(R.raw.fun_water, "别跑。")));
        menuView.addView(menuButton("聊天", this::openChat));
        menuView.addView(menuButton("打盹", () -> sleep(true)));
        menuView.addView(menuButton("关闭悬浮", () -> stopSelf()));
    }

    private TextView menuButton(String label, Runnable action) {
        TextView button = new TextView(this);
        button.setText(label);
        button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        button.setTextColor(Color.parseColor("#22302B"));
        button.setPadding(dp(14), dp(8), dp(14), dp(8));
        button.setOnClickListener((view) -> {
            hideMenu();
            action.run();
        });
        return button;
    }

    private int randomClick() {
        int[] ids = {R.raw.click_happy, R.raw.click_shy, R.raw.click_tickle, R.raw.click_wave, R.raw.click_pout};
        return ids[random.nextInt(ids.length)];
    }

    private void handleTap() {
        long now = System.currentTimeMillis();
        if (now - lastTapAt < 320) {
            handler.removeCallbacks(singleTapTask);
            lastTapAt = 0;
            feed();
            return;
        }
        lastTapAt = now;
        handler.postDelayed(singleTapTask, 320);
    }

    private void onSingleTap() {
        String[] lines = {"在呢。", "摸摸头～", "今天也慢慢来。", "我在这儿。", "要不要喝口水？", "别急，一件一件来。", "陪你一会儿。"};
        play(randomClick(), lines[random.nextInt(lines.length)]);
    }

    private void feed() {
        play(R.raw.eat_rice, "吃饱啦。");
    }

    private void play(int res, String text) {
        wake();
        petView.setImageResource(res);
        if (text != null) showBubble(text);
        handler.postDelayed(() -> {
            if (!stopped) petView.setImageResource(sleeping ? R.raw.sleep : R.raw.idle_breath);
        }, 1800);
    }

    private void sleep(boolean value) {
        sleeping = value;
        petView.setImageResource(value ? R.raw.sleep : R.raw.idle_breath);
        if (value) hideBubble();
    }

    private void wake() {
        lastInteraction = System.currentTimeMillis();
        if (sleeping) {
            sleeping = false;
            petView.setImageResource(R.raw.idle_breath);
        }
    }

    private void idleTick() {
        if (stopped) return;
        long idleFor = System.currentTimeMillis() - lastInteraction;
        if (!quiet && !sleeping && idleFor > 90000) {
            sleep(true);
        } else if (!quiet && !sleeping && idleFor > 18000 && menuView.getParent() == null) {
            int[] fun = {R.raw.idle_look, R.raw.fun_mirror, R.raw.fun_whale, R.raw.fun_water};
            petView.setImageResource(fun[random.nextInt(fun.length)]);
            handler.postDelayed(() -> {
                if (!stopped && !sleeping) petView.setImageResource(R.raw.idle_breath);
            }, 2200);
            lastInteraction = System.currentTimeMillis();
        }
        handler.postDelayed(this::idleTick, 20000);
    }

    private void showBubble(String text) {
        if (quiet || text == null || text.isEmpty()) return;
        bubbleView.setText(text.length() > 120 ? text.substring(0, 120) + "…" : text);
        bubbleView.setVisibility(View.VISIBLE);
        bubbleView.measure(
            View.MeasureSpec.makeMeasureSpec(dp(220), View.MeasureSpec.AT_MOST),
            View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED)
        );
        if (bubbleView.getParent() == null) {
            bubbleParams = new WindowManager.LayoutParams(
                dp(220),
                WindowManager.LayoutParams.WRAP_CONTENT,
                Build.VERSION.SDK_INT >= 26
                    ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                    : WindowManager.LayoutParams.TYPE_PHONE,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                    | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                    | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT
            );
            bubbleParams.gravity = Gravity.TOP | Gravity.START;
            bubbleParams.x = Math.max(0, petParams.x + dp(75) - dp(110));
            bubbleParams.y = Math.max(0, petParams.y - bubbleView.getMeasuredHeight() - dp(6));
            windowManager.addView(bubbleView, bubbleParams);
        }
        handler.removeCallbacks(hideBubbleTask);
        handler.postDelayed(hideBubbleTask, 12000);
    }

    private void hideBubble() {
        if (bubbleView != null && bubbleView.getParent() != null) {
            try {
                windowManager.removeView(bubbleView);
            } catch (Exception ignored) {
            }
        }
    }

    private void toggleMenu() {
        if (menuView.getParent() != null) {
            hideMenu();
            return;
        }
        menuView.measure(
            View.MeasureSpec.makeMeasureSpec(dp(180), View.MeasureSpec.AT_MOST),
            View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED)
        );
        int width = menuView.getMeasuredWidth();
        int height = menuView.getMeasuredHeight();
        int screenWidth = getResources().getDisplayMetrics().widthPixels;
        int screenHeight = getResources().getDisplayMetrics().heightPixels;
        menuParams = new WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            Build.VERSION.SDK_INT >= 26
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        );
        menuParams.gravity = Gravity.TOP | Gravity.START;
        int x = petParams.x + dp(150) + dp(6);
        if (x + width > screenWidth) x = petParams.x - width - dp(6);
        int y = Math.min(petParams.y, Math.max(0, screenHeight - height - dp(20)));
        menuParams.x = Math.max(0, Math.min(x, screenWidth - width - dp(4)));
        menuParams.y = Math.max(0, y);
        windowManager.addView(menuView, menuParams);
        lastInteraction = System.currentTimeMillis();
    }

    private void hideMenu() {
        if (menuView != null && menuView.getParent() != null) {
            try {
                windowManager.removeView(menuView);
            } catch (Exception ignored) {
            }
        }
    }

    private void pollLoop() {
        while (!stopped) {
            try {
                Thread.sleep(8000);
                if (quiet) continue;
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

    private void openChat() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(intent);
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        NotificationChannel channel = new NotificationChannel("qm_overlay", "桌宠悬浮", NotificationManager.IMPORTANCE_LOW);
        manager.createNotificationChannel(channel);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopped = true;
        running = false;
        handler.removeCallbacksAndMessages(null);
        try {
            if (menuView != null && menuView.getParent() != null) windowManager.removeView(menuView);
        } catch (Exception ignored) {
        }
        try {
            if (bubbleView != null && bubbleView.getParent() != null) windowManager.removeView(bubbleView);
        } catch (Exception ignored) {
        }
        try {
            if (petView != null && petView.getParent() != null) windowManager.removeView(petView);
        } catch (Exception ignored) {
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
