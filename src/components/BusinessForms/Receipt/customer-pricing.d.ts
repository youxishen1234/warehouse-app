import type { Customer, Product } from '@/types';
import type { CustomerSpecification } from '../../../backend/production-pricing';

export function matchingCustomerSpecifications(customer: Customer | null | undefined, product: Product | null | undefined): CustomerSpecification[];
export function matchingProductsForSpecification(customer: Customer | null | undefined, products: Product[], specId: string): Product[];
export function uniqueCustomerSpecification(customer: Customer | null | undefined, product: Product | null | undefined): CustomerSpecification | null;
export function validatedCustomerSpecification(customer: Customer | null | undefined, product: Product | null | undefined, specId: string): CustomerSpecification | null;
export function customerSpecificationText(specification: CustomerSpecification | null | undefined): string;
export function customerSpecificationDimensions(specification: CustomerSpecification | null | undefined): [number, number];
