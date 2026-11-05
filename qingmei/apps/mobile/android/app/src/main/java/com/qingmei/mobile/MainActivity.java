package com.qingmei.mobile;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SecureStorePlugin.class);
        registerPlugin(PetOverlayPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
