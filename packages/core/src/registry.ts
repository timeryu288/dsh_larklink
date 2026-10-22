import type { Binding, Brand, BrandEvidence, Pin, Registry } from "./types.js";

/** Registry 内存操作（纯函数；文件 IO/锁在 CLI 层，M2）。 */

export function createRegistry(): Registry {
  return { version: 1, bindings: [], pins: [] };
}

export function findBinding(registry: Registry, profile: string): Binding | undefined {
  return registry.bindings.find((b) => b.profile === profile);
}

/**
 * 可路由绑定：排除 incomplete（Q8 决议）。
 * brand 为具体品牌时按品牌过滤（design.md §5 步骤 3）；"none" 不过滤。
 */
export function routableBindings(registry: Registry, brand: BrandEvidence): Binding[] {
  return registry.bindings.filter(
    (b) => b.status !== "incomplete" && (brand === "none" || b.brand === brand),
  );
}

/** pin 以归一化 token 为键精确匹配（Q3/Q10：永久、无 TTL）。 */
export function findPin(registry: Registry, token: string): Pin | undefined {
  return registry.pins.find((p) => p.token === token);
}

export function upsertPin(registry: Registry, pin: Pin): Registry {
  const rest = registry.pins.filter((p) => p.token !== pin.token);
  return { ...registry, pins: [...rest, pin] };
}

export function removePin(registry: Registry, token: string): Registry {
  return { ...registry, pins: registry.pins.filter((p) => p.token !== token) };
}

export function upsertBinding(registry: Registry, binding: Binding): Registry {
  const rest = registry.bindings.filter((b) => b.profile !== binding.profile);
  return { ...registry, bindings: [...rest, binding] };
}

/** 删除绑定；默认保留指向它的 pins 由 health 清理（Q10），dropPins=true 时立即清理。 */
export function removeBinding(registry: Registry, profile: string, opts?: { dropPins?: boolean }): Registry {
  return {
    ...registry,
    bindings: registry.bindings.filter((b) => b.profile !== profile),
    pins: opts?.dropPins ? registry.pins.filter((p) => p.profile !== profile) : registry.pins,
  };
}

export interface RegistryIssue {
  field: string;
  message: string;
}

/** 结构校验：profile 唯一、appId 全局唯一（ADR-0001 不变量）、pin 指向存在的绑定。 */
export function validateRegistry(registry: Registry): RegistryIssue[] {
  const issues: RegistryIssue[] = [];
  const profiles = new Set<string>();
  const appIds = new Map<string, string>();
  for (const b of registry.bindings) {
    if (!b.profile) issues.push({ field: "bindings[].profile", message: "profile 名为空" });
    if (profiles.has(b.profile)) {
      issues.push({ field: "bindings[].profile", message: `profile "${b.profile}" 重复` });
    }
    profiles.add(b.profile);
    const existingOwner = appIds.get(b.appId);
    if (existingOwner !== undefined) {
      issues.push({
        field: "bindings[].appId",
        message: `appId "${b.appId}" 同时被 "${existingOwner}" 与 "${b.profile}" 使用（ADR-0001：每个绑定独立应用）`,
      });
    } else {
      appIds.set(b.appId, b.profile);
    }
  }
  for (const p of registry.pins) {
    if (!profiles.has(p.profile)) {
      issues.push({ field: "pins[].profile", message: `pin(token=${p.token.slice(0, 8)}…) 指向不存在的绑定 "${p.profile}"` });
    }
  }
  return issues;
}
