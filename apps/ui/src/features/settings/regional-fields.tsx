import { FormField } from "@/components/ui/form-field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { REGIONAL_MARKETS } from "@goodfinds/contracts/regional-data";
import { currencySchema, fulfilmentSchema } from "@goodfinds/contracts/regional";

const names = new Intl.DisplayNames(["en"], { type: "region" });
export function RegionalFields({
  country,
  currency,
  fulfilment,
  disabled,
  automatic = false,
  changeCountry,
  changeCurrency,
  changeFulfilment,
}: {
  country: string;
  currency: string;
  fulfilment: string;
  disabled: boolean;
  automatic?: boolean;
  changeCountry: (value: string) => void;
  changeCurrency: (value: string) => void;
  changeFulfilment: (value: "collection" | "delivery" | "either") => void;
}) {
  const countries = [
    ...new Set([...Object.keys(REGIONAL_MARKETS.currencies), ...(country ? [country] : [])]),
  ].toSorted((a, b) => (names.of(a) ?? a).localeCompare(names.of(b) ?? b));
  return (
    <>
      <FormField id="shopping-country" label="Shopping country">
        <NativeSelect
          id="shopping-country"
          value={country}
          disabled={disabled}
          onChange={(e) => changeCountry(e.currentTarget.value)}
        >
          <NativeSelectOption value="">
            {automatic ? "Automatic" : "Choose country"}
          </NativeSelectOption>
          {countries.map((code) => (
            <NativeSelectOption key={code} value={code}>
              {names.of(code) ?? code}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </FormField>
      <FormField id="budget-currency" label="Budget currency">
        <NativeSelect
          id="budget-currency"
          value={currency}
          disabled={disabled}
          onChange={(e) => changeCurrency(e.currentTarget.value)}
        >
          <NativeSelectOption value="">
            {automatic ? "Automatic" : "Choose currency"}
          </NativeSelectOption>
          {currencySchema.options.map((code) => (
            <NativeSelectOption key={code} value={code}>
              {code}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </FormField>
      <FormField id="shopping-fulfilment" label="Collection or delivery" full>
        <NativeSelect
          id="shopping-fulfilment"
          value={fulfilment}
          disabled={disabled}
          onChange={(e) => changeFulfilment(fulfilmentSchema.parse(e.currentTarget.value))}
        >
          <NativeSelectOption value="either">Either</NativeSelectOption>
          <NativeSelectOption value="collection">Collection</NativeSelectOption>
          <NativeSelectOption value="delivery">Delivery</NativeSelectOption>
        </NativeSelect>
      </FormField>
    </>
  );
}
