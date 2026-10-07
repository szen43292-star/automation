import type {
  IDisplayOptions,
  INodeParameters,
  INodeProperties,
  INodePropertyCollection,
  NodeParameterValueType,
} from './interfaces';
import { deepClone, isObject } from './utils';

/** Whether a property should be shown given the node's current parameter values. */
export function isPropertyVisible(
  displayOptions: IDisplayOptions | undefined,
  parameters: INodeParameters,
): boolean {
  if (!displayOptions) return true;
  if (displayOptions.show) {
    for (const [name, values] of Object.entries(displayOptions.show)) {
      if (!values.includes(parameters[name] as string | number | boolean)) return false;
    }
  }
  if (displayOptions.hide) {
    for (const [name, values] of Object.entries(displayOptions.hide)) {
      if (values.includes(parameters[name] as string | number | boolean)) return false;
    }
  }
  return true;
}

/**
 * Fill in defaults for every visible top-level property. Parameters for hidden
 * properties are dropped so stored workflows stay small and unambiguous.
 */
export function getNodeParameters(
  properties: INodeProperties[],
  current: INodeParameters,
): INodeParameters {
  const result: INodeParameters = {};
  // Two passes: properties often depend on earlier ones (e.g. `method` → `body`).
  const merged: INodeParameters = { ...current };
  for (const prop of properties) {
    if (prop.type === 'notice') continue;
    if (merged[prop.name] === undefined)
      merged[prop.name] = deepClone(prop.default) as NodeParameterValueType;
  }
  for (const prop of properties) {
    if (prop.type === 'notice') continue;
    if (!isPropertyVisible(prop.displayOptions, merged)) continue;
    result[prop.name] = merged[prop.name] as NodeParameterValueType;
  }
  return result;
}

/** Look up a property's definition, following collection paths like `options.timeout`. */
export function findProperty(
  properties: INodeProperties[],
  path: string,
): INodeProperties | undefined {
  const [head, ...rest] = path.split('.');
  const prop = properties.find((p) => p.name === head);
  if (!prop || rest.length === 0) return prop;
  if (prop.type === 'collection') {
    return findProperty((prop.options ?? []) as INodeProperties[], rest.join('.'));
  }
  if (prop.type === 'fixedCollection') {
    const [group, ...inner] = rest;
    const coll = (prop.options as INodePropertyCollection[] | undefined)?.find(
      (c) => c.name === group,
    );
    return coll && inner.length ? findProperty(coll.values, inner.join('.')) : undefined;
  }
  return undefined;
}

export function getDefaultForPath(properties: INodeProperties[], path: string): unknown {
  return findProperty(properties, path)?.default;
}

export function isCollectionOption(value: unknown): value is INodeProperties {
  return isObject(value) && 'displayName' in value && 'type' in value;
}
