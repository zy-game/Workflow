package com.qingmei.mobile;

import android.Manifest;
import android.content.Intent;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.os.Bundle;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;

/**
 * Android 原生语音识别桥。WebView 没有 Web Speech API，移动端用它回退；
 * 识别结果通过 partial/result/error 事件回传 JS。
 */
@CapacitorPlugin(
    name = "QmSpeech",
    permissions = @Permission(
        alias = "microphone",
        strings = { Manifest.permission.RECORD_AUDIO }
    )
)
public class QmSpeechPlugin extends Plugin {
    private SpeechRecognizer recognizer;

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "startAfterPermission");
            return;
        }
        begin(call);
    }

    @PermissionCallback
    private void startAfterPermission(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            call.reject("需要麦克风权限");
            return;
        }
        begin(call);
    }

    private void begin(PluginCall call) {
        if (getActivity() == null) {
            call.reject("没有可用的 Activity");
            return;
        }
        getActivity().runOnUiThread(() -> beginOnUi(call));
    }

    private void beginOnUi(PluginCall call) {
        try {
            if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
                call.reject("设备没有可用的语音识别服务");
                return;
            }
            stopRecognizer();
            recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
            recognizer.setRecognitionListener(new RecognitionListener() {
                @Override public void onReadyForSpeech(Bundle params) { notifyListeners("ready", new JSObject()); }
                @Override public void onBeginningOfSpeech() { notifyListeners("speechStart", new JSObject()); }
                @Override public void onRmsChanged(float rmsdB) {}
                @Override public void onBufferReceived(byte[] buffer) {}
                @Override public void onEndOfSpeech() { notifyListeners("speechEnd", new JSObject()); }

                @Override
                public void onError(int error) {
                    JSObject data = new JSObject();
                    data.put("code", error);
                    data.put("message", errorText(error));
                    notifyListeners("error", data);
                }

                @Override
                public void onResults(Bundle results) {
                    JSObject data = new JSObject();
                    data.put("text", firstResult(results));
                    notifyListeners("result", data);
                }

                @Override
                public void onPartialResults(Bundle partialResults) {
                    JSObject data = new JSObject();
                    data.put("text", firstResult(partialResults));
                    notifyListeners("partial", data);
                }

                @Override public void onEvent(int eventType, Bundle params) {}
            });

            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN");
            intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
            recognizer.startListening(intent);
            call.resolve();
        } catch (Throwable error) {
            stopRecognizer();
            call.reject(error.getMessage() == null ? "语音启动失败" : error.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (getActivity() == null) {
            call.resolve();
            return;
        }
        getActivity().runOnUiThread(() -> {
            if (recognizer != null) recognizer.stopListening();
            call.resolve();
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        if (getActivity() == null) {
            call.resolve();
            return;
        }
        getActivity().runOnUiThread(() -> {
            stopRecognizer();
            call.resolve();
        });
    }

    private void stopRecognizer() {
        if (recognizer != null) {
            try {
                recognizer.destroy();
            } catch (Exception ignored) {
            }
            recognizer = null;
        }
    }

    private String firstResult(Bundle results) {
        ArrayList<String> matches = results == null
            ? null
            : results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return matches != null && !matches.isEmpty() ? matches.get(0) : "";
    }

    private String errorText(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_AUDIO: return "录音失败";
            case SpeechRecognizer.ERROR_CLIENT: return "语音客户端错误";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: return "没有麦克风权限";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT: return "语音服务网络错误";
            case SpeechRecognizer.ERROR_NO_MATCH: return "没有识别到内容";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: return "语音识别忙";
            case SpeechRecognizer.ERROR_SERVER: return "语音服务错误";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT: return "没有检测到语音";
            default: return "语音识别失败";
        }
    }

    @Override
    protected void handleOnDestroy() {
        stopRecognizer();
        super.handleOnDestroy();
    }
}
