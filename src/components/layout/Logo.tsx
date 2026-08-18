import { useBrand } from "@/lib/brand";

export function Logo({ size = 28, withName = true }: { size?: number; withName?: boolean }) {
  const brand = useBrand();
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      {brand.logoUrl ? (
        <img src={brand.logoUrl} alt="" className="shrink-0 rounded-ui-sm object-contain" style={{ width: size, height: size }} />
      ) : (
        <span
          className="flex shrink-0 items-center justify-center rounded-ui-sm bg-accent font-bold text-accent-fg"
          style={{ width: size, height: size, fontSize: size * (brand.monogram.length > 2 ? 0.32 : 0.4) }}
        >
          {brand.monogram}
        </span>
      )}
      {withName && <span className="truncate text-[15px] font-semibold tracking-tight text-fg">{brand.productName}</span>}
    </span>
  );
}
