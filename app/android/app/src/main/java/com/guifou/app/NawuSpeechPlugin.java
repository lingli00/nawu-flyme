package com.guifou.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

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
 * ★v1.3.6 · 端侧语音识别插件（NawuSpeech）。
 *
 * 需求原点：语音转文字不能再依赖云端。旧版走 WebView 的 Web Speech API，
 * 在 Android 上那套 API 实际是把音频送到 **Google 在线识别服务**——
 * 于是「服务端/外网一抖，语音输入就报网络错误」，而用户明明只想记一笔账。
 *
 * 本插件把识别改到**手机本地**：
 *  - Android 12（API 31）及以上，系统提供 `createOnDeviceSpeechRecognizer()`，
 *    完全在本机跑声学模型（Flyme/各家 ROM 都随系统带中文离线包）；
 *  - 低版本或本机没有离线引擎时，退回系统识别器并强制 `EXTRA_PREFER_OFFLINE=true`，
 *    仍然优先本地、不走网络；
 *  - 万一系统连识别服务都没有，`isAvailable()` 返回 supported=false，
 *    前端提示「本机没有离线语音引擎，请用键盘输入」，绝不静默失败。
 *
 * 生命周期：SpeechRecognizer 必须在主线程创建/销毁，本插件所有调用都投递到
 * UI 线程；同一时刻只保留一个识别实例（destroy 前先 cancel）。
 */
@CapacitorPlugin(
    name = "NawuSpeech",
    permissions = { @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "microphone") }
)
public class NawuSpeechPlugin extends Plugin {

    private SpeechRecognizer recognizer = null;
    /** 当前是否用的是「纯离线」识别器（onDevice=true 时不会走网络）。 */
    private boolean onDevice = false;
    /** ★v1.3.7：系统识别器不可用时的兜底——拉起任意能处理识别 Intent 的应用。 */
    private static final int REQ_SPEECH = 0x5350;
    /** ★v1.3.8 重试状态：本次会话语言 / 已尝试次数（标准 → 离线 共 2 次）。 */
    private String pendingLang = null;
    private int attempt = 0;
    private static final int MAX_ATTEMPTS = 2;

    /* ==================== 能力探测 ==================== */

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        boolean supported = SpeechRecognizer.isRecognitionAvailable(getContext());
        boolean device = false;
        if (Build.VERSION.SDK_INT >= 31) {
            device = SpeechRecognizer.isOnDeviceRecognitionAvailable(getContext());
        }
        // ★v1.3.7：绑不到识别器时，只要系统里有应用能处理识别 Intent 就算「可用」，
        // 否则前端会提前判成「功能不可用」，连兜底机会都没有。
        boolean intentOk = false;
        try {
            Intent probe = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intentOk = probe.resolveActivity(getContext().getPackageManager()) != null;
        } catch (Exception ignored) {
            /* 查询失败按不可用处理 */
        }
        ret.put("supported", supported || device || intentOk);
        ret.put("onDevice", device);
        ret.put(
            "engine",
            device ? "android-ondevice" : supported ? "android-service" : intentOk ? "android-intent" : "none"
        );
        ret.put("permission", getPermissionState("microphone").toString());
        call.resolve(ret);
    }

    /* ==================== 开始识别 ==================== */

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "micPermsCallback");
            return;
        }
        startListening(call);
    }

    @PermissionCallback
    private void micPermsCallback(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            startListening(call);
            return;
        }
        emitError("not-allowed", "麦克风权限被拒绝");
        call.reject("not-allowed");
    }

    private void startListening(final PluginCall call) {
        final Activity activity = getActivity();
        if (activity == null) {
            emitError("no-activity", "插件未绑定 Activity");
            call.reject("no-activity");
            return;
        }
        final String lang = call.getString("lang", "zh-CN");
        activity.runOnUiThread(() -> {
            destroyRecognizer();
            pendingLang = lang;
            pendingStartCall = call;
            attempt = 0;
            // ★v1.3.8：**标准识别器优先**。旧版 Android 12+ 一律走
            // createOnDeviceSpeechRecognizer + 强制离线，不少 ROM 的离线引擎
            // 根本没有中文模型，start 后秒报 ERROR_CLIENT——用户看到的就是
            // 「点击按住说话立刻弹出识别失败」。标准识别器会绑到系统当前
            // 语音服务（讯飞/语音助手等，在线离线均可），兼容性远好于纯离线。
            tryStart(false, call);
        });
    }

    /**
     * ★v1.3.8 引擎选择：标准识别器优先（兼容 ROM 自带语音服务），离线为备选。
     *
     * @param wantOnDevice true = 纯离线识别器；false = 标准识别器
     */
    private void tryStart(final boolean wantOnDevice, final PluginCall call) {
        final Activity activity = getActivity();
        if (activity == null) return;
        final String lang = pendingLang == null ? "zh-CN" : pendingLang;
        attempt += 1;
        try {
            if (!wantOnDevice) {
                if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
                    // 标准识别器都没有 → 换离线（再不行由离线分支转 Intent 兜底）
                    tryStart(true, call);
                    return;
                }
                recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
                onDevice = false;
            } else {
                if (Build.VERSION.SDK_INT < 31 || !SpeechRecognizer.isOnDeviceRecognitionAvailable(getContext())) {
                    startIntentRecognizer(call, lang);
                    return;
                }
                recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(getContext());
                onDevice = true;
            }
            recognizer.setRecognitionListener(recognitionListener);
            final Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, lang);
            intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
            // ★v1.3.8：不再强制 EXTRA_PREFER_OFFLINE——离线引擎缺中文模型时
            // 这是「秒报失败」的直接原因；标准识别器在线/离线由引擎自选。
            if (wantOnDevice) {
                // onDevice 识别器创建后服务异步绑定，立刻 startListening 会秒报
                // ERROR_CLIENT；延迟 200ms 等绑定完成（标准识别器无此问题）。
                final Intent delayed = intent;
                new android.os.Handler(android.os.Looper.getMainLooper())
                        .postDelayed(startDelayedRunnable(delayed, call), 200);
                return;
            }
            recognizer.startListening(intent);
            JSObject ret = new JSObject();
            ret.put("onDevice", false);
            call.resolve(ret);
        } catch (Exception e) {
            emitError("start-failed", e.getMessage() == null ? "语音启动失败" : e.getMessage());
            call.reject("start-failed");
        }
    }

    /** onDevice 延迟启动的 Runnable（服务异步绑定完成后真正开始听）。 */
    private Runnable startDelayedRunnable(final Intent intent, final PluginCall call) {
        return () -> {
            try {
                if (recognizer != null) {
                    recognizer.startListening(intent);
                    JSObject ret = new JSObject();
                    ret.put("onDevice", true);
                    call.resolve(ret);
                } else {
                    call.reject("start-failed");
                }
            } catch (Exception e) {
                emitError("start-failed", e.getMessage() == null ? "语音启动失败" : e.getMessage());
                call.reject("start-failed");
            }
        };
    }

    /**
     * ★v1.3.7 Intent 兜底：让系统里任意「语音输入」应用来转写。
     *
     * 场景：某些 ROM（尤其精简版系统）把 SpeechRecognizer 的绑定服务删了，
     * `isRecognitionAvailable()` 直接 false，但输入法/语音助手仍能处理
     * `ACTION_RECOGNIZE_SPEECH`。此时拉起该 Activity，用户说完后回到 App，
     * 结果在 `handleOnActivityResult` 里取 EXTRA_RESULTS。
     *
     * 这条路径**一定**会离开 App 界面，所以只在完全绑不到识别器时才走。
     */
    private void startIntentRecognizer(final PluginCall call, final String lang) {
        final Activity activity = getActivity();
        if (activity == null) {
            emitError("no-activity", "插件未绑定 Activity");
            call.reject("no-activity");
            return;
        }
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, lang);
        intent.putExtra(RecognizerIntent.EXTRA_PROMPT, "请说出要记的内容");
        if (intent.resolveActivity(activity.getPackageManager()) == null) {
            emitError("unavailable", "本机没有可用的语音识别引擎");
            call.reject("unavailable");
            return;
        }
        try {
            activity.startActivityForResult(intent, REQ_SPEECH);
            JSObject ret = new JSObject();
            ret.put("onDevice", false);
            ret.put("engine", "android-intent");
            call.resolve(ret);
        } catch (Exception e) {
            emitError("start-failed", e.getMessage() == null ? "语音启动失败" : e.getMessage());
            call.reject("start-failed");
        }
    }

    /** Intent 兜底路径的结果回传。 */
    @Override
    protected void handleOnActivityResult(int requestCode, int resultCode, Intent data) {
        super.handleOnActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_SPEECH) return;

        if (resultCode == Activity.RESULT_OK && data != null) {
            ArrayList<String> list = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
            String text = (list != null && !list.isEmpty() && list.get(0) != null) ? list.get(0).trim() : "";
            if (!text.isEmpty()) {
                JSObject r = new JSObject();
                r.put("text", text);
                r.put("onDevice", false);
                notifyListeners("result", r);
                notifyListeners("end", new JSObject());
                return;
            }
        }
        // 用户返回/没说话：按「取消」处理，不弹错误提示
        JSObject err = new JSObject();
        err.put("code", "cancelled");
        err.put("message", "已取消");
        notifyListeners("error", err);
        notifyListeners("end", new JSObject());
    }

    /* ==================== 停止 / 取消 ==================== */
    @PluginMethod
    public void stop(PluginCall call) {
        final Activity activity = getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }
        activity.runOnUiThread(() -> {
            try {
                if (recognizer != null) {
                    // stopListening 会让系统把已听到的内容作为 onResults 回调回来
                    recognizer.stopListening();
                }
            } catch (Exception ignored) {
                /* 已结束的实例再 stop 会抛，忽略即可 */
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        final Activity activity = getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }
        activity.runOnUiThread(() -> {
            destroyRecognizer();
            call.resolve();
        });
    }

    /** 销毁识别实例（必须在主线程调用）。 */
    private void destroyRecognizer() {
        if (recognizer == null) return;
        try {
            recognizer.cancel();
        } catch (Exception ignored) {
            /* noop */
        }
        try {
            recognizer.destroy();
        } catch (Exception ignored) {
            /* noop */
        }
        recognizer = null;
    }

    @Override
    protected void handleOnDestroy() {
        destroyRecognizer();
        super.handleOnDestroy();
    }

    /* ==================== 回调 ==================== */

    private void emitError(String code, String message) {
        JSObject r = new JSObject();
        r.put("code", code);
        r.put("message", message);
        notifyListeners("error", r);
    }

    /** 从 results Bundle 里取第一条转写。 */
    private String firstText(Bundle results) {
        if (results == null) return "";
        ArrayList<String> list = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (list == null || list.isEmpty()) return "";
        String s = list.get(0);
        return s == null ? "" : s.trim();
    }

    /** Android 错误码 → 前端可读的分类（前端据 code 出中文提示）。 */
    private String mapError(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_AUDIO:
                return "audio";
            case SpeechRecognizer.ERROR_CLIENT:
                return "client";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "not-allowed";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                return "network";
            case SpeechRecognizer.ERROR_NO_MATCH:
                return "no-match";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "busy";
            case SpeechRecognizer.ERROR_SERVER:
                return "server";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "speech-timeout";
            default:
                return "unknown";
        }
    }

    /**
     * ★v1.3.8 出错自动换引擎重试一次。
     *
     * 场景：标准识别器在部分 ROM 上会秒报 ERROR_CLIENT / ERROR_NO_MATCH，
     * 而离线识别器可能正常（反之亦然）。第一次错误时若还有重试额度
     * （MAX_ATTEMPTS=2），自动销毁当前实例、换成另一引擎重新开始听——
     * 前端无感知；两个引擎都失败才把错误交给前端。
     */
    private boolean retryWithOtherEngine() {
        final PluginCall call = pendingStartCall;
        if (call == null || attempt >= MAX_ATTEMPTS) return false;
        final String lang = pendingLang == null ? "zh-CN" : pendingLang;
        destroyRecognizer();
        final boolean next = !onDevice;
        attempt += 1;
        try {
            if (!next) {
                if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
                    return false;
                }
                recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
                onDevice = false;
            } else {
                if (Build.VERSION.SDK_INT < 31 || !SpeechRecognizer.isOnDeviceRecognitionAvailable(getContext())) {
                    return false;
                }
                recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(getContext());
                onDevice = true;
            }
            recognizer.setRecognitionListener(recognitionListener);
            final Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, lang);
            intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
            if (next) {
                new android.os.Handler(android.os.Looper.getMainLooper())
                        .postDelayed(startDelayedRunnable(intent, call), 200);
            } else {
                recognizer.startListening(intent);
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** 本次 start 调用的引用（重试时需要重新 resolve）。 */
    private PluginCall pendingStartCall = null;

    private final RecognitionListener recognitionListener = new RecognitionListener() {
        @Override
        public void onReadyForSpeech(Bundle params) {
            /* 前端按下即已进入录音态，无需额外事件 */
        }

        @Override
        public void onBeginningOfSpeech() {
            /* noop */
        }

        @Override
        public void onRmsChanged(float rmsdB) {
            /* noop：界面用计时条反馈，不做电平动画 */
        }

        @Override
        public void onBufferReceived(byte[] buffer) {
            /* noop */
        }

        @Override
        public void onEndOfSpeech() {
            /* noop */
        }

        @Override
        public void onError(int error) {
            String code = mapError(error);
            // ★v1.3.8 权限/音频占用没有重试意义；其余错误先换引擎重试一次，
            // 重试也失败才通知前端（用户感知就是「多等一下」，而不是秒弹失败）。
            boolean canRetry = attempt < MAX_ATTEMPTS
                    && !"not-allowed".equals(code)
                    && !"audio".equals(code);
            if (canRetry && retryWithOtherEngine()) return;
            emitError(code, code);
            JSObject end = new JSObject();
            end.put("reason", "error");
            notifyListeners("end", end);
        }

        @Override
        public void onResults(Bundle results) {
            String text = firstText(results);
            JSObject r = new JSObject();
            r.put("text", text);
            r.put("onDevice", onDevice);
            notifyListeners("result", r);
            JSObject end = new JSObject();
            end.put("reason", "result");
            notifyListeners("end", end);
        }

        @Override
        public void onPartialResults(Bundle partialResults) {
            String text = firstText(partialResults);
            if (text.isEmpty()) return;
            JSObject r = new JSObject();
            r.put("text", text);
            r.put("onDevice", onDevice);
            notifyListeners("partial", r);
        }

        @Override
        public void onEvent(int eventType, Bundle params) {
            /* noop */
        }
    };
}
