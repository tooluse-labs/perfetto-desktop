// Copyright (C) 2026 Tooluse Labs
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0

export interface SecretBridge {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const sessionSecrets = new Map<string, string>();

export function createSessionSecretBridge(): SecretBridge {
  return {
    async get(key: string): Promise<string | undefined> {
      return sessionSecrets.get(key);
    },
    async set(key: string, value: string): Promise<void> {
      sessionSecrets.set(key, value);
    },
    async delete(key: string): Promise<void> {
      sessionSecrets.delete(key);
    },
  };
}
