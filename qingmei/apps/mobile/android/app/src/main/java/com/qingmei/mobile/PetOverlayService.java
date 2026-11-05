package com.qingmei.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.IBinder;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.WindowManager;
import android.widget.ImageView;

public class PetOverlayService extends Service {
    public static boolean running = false;
    private WindowManager windowManager;
    private ImageView petView;
    private WindowManager.LayoutParams params;
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
        petView = new ImageView(this);
        petView.setImageResource(R.drawable.pet_alpha);
        petView.setBackgroundColor(Color.TRANSPARENT);
        petView.setScaleType(ImageView.ScaleType.FIT_CENTER);

        int size = Math.round(150 * getResources().getDisplayMetrics().density);
        params = new WindowManager.LayoutParams(
            size,
            size,
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
                    windowManager.updateViewLayout(petView, params);
                    return true;
                case MotionEvent.ACTION_UP:
                    if (!moved) {
                        Intent intent = new Intent(this, MainActivity.class);
                        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                        startActivity(intent);
                    }
                    return true;
                default:
                    return false;
            }
        });

        windowManager.addView(petView, params);
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        NotificationChannel channel = new NotificationChannel("qm_overlay", "桌宠悬浮", NotificationManager.IMPORTANCE_LOW);
        manager.createNotificationChannel(channel);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (petView != null && windowManager != null) {
            try {
                windowManager.removeView(petView);
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
