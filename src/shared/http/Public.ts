import { SetMetadata, type CustomDecorator } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Com o `AuthGuard` no-op tudo passa, mas o marcador já existe para que trocar
 * por um guard real não exija revisitar cada controller.
 */
export const Public = (): CustomDecorator<string> => SetMetadata(IS_PUBLIC_KEY, true);
