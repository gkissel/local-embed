import type postgres from 'postgres';
/** Provisioned administratively; poller startup performs no DDL. */
export async function installPollingState(tx: postgres.TransactionSql): Promise<void> {
  await tx.unsafe(`CREATE TABLE IF NOT EXISTS localembed.polling_state (
    configuration_id bigint NOT NULL REFERENCES localembed.configurations(id), entity text NOT NULL,
    cursor_time timestamptz NOT NULL DEFAULT '-infinity', cursor_id text,
    window_end timestamptz NOT NULL DEFAULT clock_timestamp(),
    sweep_cursor text, sweep_upper text, delete_cursor text, delete_upper text, phase text NOT NULL DEFAULT 'source',
    next_reconcile timestamptz NOT NULL DEFAULT '-infinity',
    PRIMARY KEY(configuration_id, entity))`);
}
