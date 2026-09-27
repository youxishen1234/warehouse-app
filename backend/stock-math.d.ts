export function roundDecimal(value: number, places: number): number;
export function numberValue(value: unknown, label: string, positive?: boolean): number;
export function lineAmount(quantity: number, price: number): number;
export function dimensions(specification: string, product?: { length?: number; width?: number }): [number, number];
export function localDate(date?: Date): string;
