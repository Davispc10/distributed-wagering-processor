/**
 * Prova, contra PostgreSQL real, que sob Bun funcionam: EntitySchema sem
 * decorators, `em.transactional()` com rollback, `LockMode.PESSIMISTIC_WRITE`
 * serializando escritas concorrentes e NUMERIC(20,2) chegando como string.
 *
 * Uso: bun scripts/smoke-mikro-orm.ts
 */
import { EntitySchema, LockMode, MikroORM } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Decimal } from 'decimal.js';

class SmokeWallet {
  id!: string;
  balanceAmount!: string;
  version!: number;
}

const SmokeWalletSchema = new EntitySchema<SmokeWallet>({
  class: SmokeWallet,
  tableName: 'smoke_wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    balanceAmount: { type: 'decimal', columnType: 'numeric(20,2)', fieldName: 'balance_amount' },
    version: { type: 'integer', default: 1 },
  },
});

const WALLET_ID = '00000000-0000-4000-8000-000000000001';

async function main(): Promise<void> {
  const orm = await MikroORM.init({
    driver: PostgreSqlDriver,
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 55432),
    dbName: process.env.POSTGRES_DB ?? 'wagering_test',
    user: process.env.POSTGRES_USER ?? 'wagering',
    password: process.env.POSTGRES_PASSWORD ?? 'wagering',
    entities: [SmokeWalletSchema],
    debug: false,
    allowGlobalContext: true,
  });

  const results: string[] = [];
  // Anotação explícita no `const`: sem ela o TS não estreita o tipo após a chamada.
  const fail: (msg: string) => never = (msg) => {
    throw new Error(msg);
  };

  try {
    const em = orm.em.fork();
    await em.getConnection().execute('DROP TABLE IF EXISTS smoke_wallets');
    await em.getConnection().execute(`
      CREATE TABLE smoke_wallets (
        id             uuid PRIMARY KEY,
        balance_amount numeric(20,2) NOT NULL,
        version        integer NOT NULL DEFAULT 1,
        CONSTRAINT smoke_wallets_balance_non_negative CHECK (balance_amount >= 0)
      )
    `);
    await em
      .getConnection()
      .execute(`INSERT INTO smoke_wallets (id, balance_amount, version) VALUES (?, ?, 1)`, [
        WALLET_ID,
        '100.00',
      ]);
    results.push('✓ schema criado com CHECK (balance_amount >= 0)');

    const raw = await em
      .getConnection()
      .execute<Array<{ balance_amount: unknown }>>(
        'SELECT balance_amount FROM smoke_wallets WHERE id = ?',
        [WALLET_ID],
      );
    const rawBalance = raw[0]?.balance_amount;
    if (typeof rawBalance !== 'string') {
      fail(`NUMERIC voltou como ${typeof rawBalance} (${String(rawBalance)}), esperado string`);
    }
    results.push(`✓ NUMERIC(20,2) chega como string ("${rawBalance}") — Money reidrata exato`);

    await em
      .transactional(async (tx) => {
        await tx
          .getConnection()
          .execute(
            'UPDATE smoke_wallets SET balance_amount = ? WHERE id = ?',
            ['999.00', WALLET_ID],
            'run',
            tx.getTransactionContext(),
          );
        throw new Error('rollback proposital');
      })
      .catch((e: unknown) => {
        if (!(e instanceof Error) || e.message !== 'rollback proposital') throw e;
      });

    const afterRollback = await orm.em
      .fork()
      .getConnection()
      .execute<Array<{ balance_amount: string }>>(
        'SELECT balance_amount FROM smoke_wallets WHERE id = ?',
        [WALLET_ID],
      );
    if (afterRollback[0]?.balance_amount !== '100.00') {
      fail(`rollback não reverteu: saldo ficou ${String(afterRollback[0]?.balance_amount)}`);
    }
    results.push('✓ em.transactional() faz rollback de verdade');

    let checkRejected = false;
    try {
      await orm.em
        .fork()
        .getConnection()
        .execute('UPDATE smoke_wallets SET balance_amount = ? WHERE id = ?', ['-1.00', WALLET_ID]);
    } catch {
      checkRejected = true;
    }
    if (!checkRejected) fail('o CHECK (balance_amount >= 0) NÃO rejeitou saldo negativo');
    results.push('✓ CHECK do banco rejeita saldo negativo (rede final da concorrência)');

    // Cenário obrigatório: saldo 100, dois débitos de 80 simultâneos.
    const debit = async (label: string): Promise<'PROCESSED' | 'REJECTED'> => {
      const forked = orm.em.fork();
      return forked.transactional(async (tx) => {
        const wallet = await tx.findOne(
          SmokeWalletSchema,
          { id: WALLET_ID },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );
        if (!wallet) fail(`${label}: wallet não encontrada`);

        const balance = new Decimal(wallet.balanceAmount);
        const amount = new Decimal('80.00');
        if (balance.lessThan(amount)) return 'REJECTED';

        // Pausa dentro do lock: sem lock de linha, ambos leriam 100 e o
        // segundo sobrescreveria o primeiro (lost update).
        await new Promise((r) => setTimeout(r, 120));

        wallet.balanceAmount = balance.minus(amount).toFixed(2);
        wallet.version += 1;
        await tx.flush();
        return 'PROCESSED';
      });
    };

    const outcomes = await Promise.all([debit('A'), debit('B')]);
    const processed = outcomes.filter((o) => o === 'PROCESSED').length;
    const rejected = outcomes.filter((o) => o === 'REJECTED').length;

    const finalRow = await orm.em
      .fork()
      .getConnection()
      .execute<Array<{ balance_amount: string; version: number }>>(
        'SELECT balance_amount, version FROM smoke_wallets WHERE id = ?',
        [WALLET_ID],
      );
    const finalBalance = finalRow[0]?.balance_amount;
    const finalVersion = finalRow[0]?.version;

    if (processed !== 1 || rejected !== 1) {
      fail(`esperado 1 PROCESSED e 1 REJECTED, veio ${processed}/${rejected}`);
    }
    if (finalBalance !== '20.00') {
      fail(`saldo final esperado 20.00, veio ${String(finalBalance)}`);
    }
    results.push(
      `✓ LockMode.PESSIMISTIC_WRITE serializa: 1 PROCESSED, 1 REJECTED, saldo ${finalBalance}, version ${String(finalVersion)}`,
    );

    await orm.em.fork().getConnection().execute('DROP TABLE smoke_wallets');

    console.log('\n  SMOKE TEST — MikroORM sob Bun\n');
    for (const r of results) console.log(`  ${r}`);
    console.log('\n  Resultado: stack viável. Risco "MikroORM + Bun" pode ser fechado.\n');
  } finally {
    await orm.close(true);
  }
}

main().catch((e: unknown) => {
  console.error('\n  SMOKE TEST FALHOU:', e instanceof Error ? e.message : e, '\n');
  process.exit(1);
});
