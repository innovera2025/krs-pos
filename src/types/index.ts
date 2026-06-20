export type Product = {
  id: string;
  name: string;
  sku: string;
  price: number;
  stock: number;
  barcode?: string | null;
  imageUrl?: string | null;
  isActive: boolean;
  categoryId?: string | null;
  category?: { id: string; name: string } | null;
};

export type CartItem = {
  product: Product;
  quantity: number;
};

export type Category = {
  id: string;
  name: string;
};
