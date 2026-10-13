import { INBOXOS_WORDMARK, isStockBrand } from "@shared/brand";
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

/**
 * The brand on a dark backdrop (sign-in hero, phone brand strip): the InboxOS wordmark
 * on a stock install, otherwise the logo or a white monogram tile beside `label`.
 */
export function HeroLogo({ label }: { label: string }) {
  const brand = useBrand();
  if (isStockBrand(brand)) return <img src={INBOXOS_WORDMARK} alt={brand.productName} className="h-8 w-auto" />;
  return (
    <span className="flex items-center gap-2.5">
      {brand.logoUrl ? (
        <img src={brand.logoUrl} alt="" className="size-8 rounded-lg object-contain" />
      ) : (
        <span className="flex size-8 items-center justify-center rounded-lg bg-white text-xs font-bold text-black">{brand.monogram}</span>
      )}
      {label && <span className="text-sm font-semibold tracking-tight">{label}</span>}
    </span>
  );
}
