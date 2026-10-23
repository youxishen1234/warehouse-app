export interface CustomerSpecification {
  id: string;
  goods: string;
  specification?: string;
  /** Legacy customer-dimensions representation. */
  size?: string;
  /** Physical dimension unit for size/specification, not the stock unit. */
  sizeUnit?: string;
  material: string;
  /** Inventory unit, for example 个. */
  unit: string;
  price: number;
}

export interface CustomerWithSpecifications {
  id: number;
  name: string;
  deleted_at?: number | null;
  specs?: CustomerSpecification[];
}

export interface ProductionCartonProduct {
  id: number;
  name: string;
  category?: string;
  specification: string;
  /** Optional physical dimension unit; defaults to cm. */
  size_unit?: string;
  material?: string;
  unit: string;
  deleted_at?: number | null;
}

export interface CustomerSpecificationMatch {
  specification: CustomerSpecification;
  /** Customer specification dimensions converted to centimetres. */
  dimensionsCm: number[];
  snapshot: Pick<CustomerSpecification, 'id' | 'goods' | 'material' | 'unit' | 'price'> & {
    specification: string;
  };
}

/** Parse two- or three-dimensional sizes and normalize them into centimetres. */
export function dimensionsInCm(specification: string, dimensionUnit?: string): number[] | null;
/** Return a specification only when the ID belongs to this active customer. */
export function findCustomerSpecification(
  customer: CustomerWithSpecifications | null | undefined,
  specId: string,
): CustomerSpecification | null;
/** Validate customer ownership and product size/unit/material compatibility. Throws a Chinese Error on mismatch. */
export function matchCustomerSpecification(
  customer: CustomerWithSpecifications | null | undefined,
  product: ProductionCartonProduct | null | undefined,
  specId: string,
): CustomerSpecificationMatch;
