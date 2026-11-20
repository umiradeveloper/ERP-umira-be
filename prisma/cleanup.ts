import { PrismaClient } from '@prisma/client';

/** Hapus seluruh data satu tenant (urutan menghormati foreign key). Dipakai seed & test. */
export async function deleteTenant(prisma: PrismaClient, tenantId: string) {
  const w = { where: { tenantId } };
  await prisma.notification.deleteMany(w);
  await prisma.devicePushToken.deleteMany(w);
  await prisma.fileObject.deleteMany(w);
  await prisma.quotationLine.deleteMany(w);
  await prisma.supplierQuotation.deleteMany(w);
  await prisma.rfqSupplier.deleteMany(w);
  await prisma.rfqItem.deleteMany(w);
  await prisma.rfq.deleteMany(w);
  await prisma.stockMovement.deleteMany(w);
  await prisma.stockBalance.deleteMany(w);
  await prisma.inventoryItem.deleteMany(w);
  await prisma.warehouse.deleteMany(w);
  await prisma.variationOrderItem.deleteMany(w);
  await prisma.variationOrder.deleteMany(w);
  await prisma.approvalDecision.deleteMany(w);
  await prisma.approvalRequest.deleteMany(w);
  await prisma.workflowDefinition.deleteMany(w);
  await prisma.journalLine.deleteMany(w);
  await prisma.journalEntry.deleteMany(w);
  await prisma.accountingPeriod.deleteMany(w);
  await prisma.account.deleteMany(w);
  await prisma.customerReceipt.deleteMany(w);
  await prisma.customerInvoice.deleteMany(w);
  await prisma.supplierPayment.deleteMany(w);
  await prisma.supplierInvoice.deleteMany(w);
  await prisma.goodsReceiptLine.deleteMany(w);
  await prisma.goodsReceipt.deleteMany(w);
  await prisma.purchaseOrderItem.deleteMany(w);
  await prisma.purchaseOrder.deleteMany(w);
  await prisma.purchaseRequestItem.deleteMany(w);
  await prisma.purchaseRequest.deleteMany(w);
  await prisma.projectCost.deleteMany(w);
  await prisma.budgetItem.deleteMany(w);
  await prisma.budget.deleteMany(w);
  await prisma.bqItem.deleteMany(w);
  await prisma.progressEntry.deleteMany(w);
  await prisma.dailyReport.deleteMany(w);
  await prisma.assetMaintenance.deleteMany(w);
  await prisma.assetMovement.deleteMany(w);
  await prisma.asset.deleteMany(w);
  await prisma.project.deleteMany(w);
  await prisma.tenderItem.deleteMany(w);
  await prisma.tender.deleteMany(w);
  await prisma.customer.deleteMany(w);
  await prisma.supplier.deleteMany(w);
  await prisma.sequenceCounter.deleteMany(w);
  await prisma.auditLog.deleteMany(w);
  await prisma.refreshToken.deleteMany(w);
  await prisma.membership.deleteMany(w);
  await prisma.role.deleteMany(w);
  await prisma.user.deleteMany(w);
  await prisma.company.deleteMany(w);
  await prisma.tenant.delete({ where: { id: tenantId } });
}

/**
 * Kosongkan data transaksi satu tenant tanpa menghapus perusahaannya.
 * Selalu DIPERTAHANKAN: perusahaan, user, role, akses, alur approval, bagan akun (COA), periode akuntansi, token push HP.
 * master=false (default): customer, supplier, gudang, master barang dan aset juga dipertahankan.
 * master=true: data master tersebut ikut dihapus.
 * Mengembalikan jumlah baris yang dihapus per tabel.
 */
export async function resetTenantData(prisma: PrismaClient, tenantId: string, opts: { master?: boolean } = {}) {
  const w = { where: { tenantId } };
  const done: Record<string, number> = {};
  const del = async (name: string, fn: () => Promise<{ count: number }>) => {
    const r = await fn();
    if (r.count) done[name] = r.count;
  };
  await prisma.$transaction(async (tx) => {
    await del('Notifikasi', () => tx.notification.deleteMany(w));
    await del('File unggahan', () => tx.fileObject.deleteMany(w));
    await del('Baris penawaran supplier', () => tx.quotationLine.deleteMany(w));
    await del('Penawaran supplier', () => tx.supplierQuotation.deleteMany(w));
    await del('Supplier RFQ', () => tx.rfqSupplier.deleteMany(w));
    await del('Item RFQ', () => tx.rfqItem.deleteMany(w));
    await del('RFQ', () => tx.rfq.deleteMany(w));
    await del('Mutasi stok', () => tx.stockMovement.deleteMany(w));
    await del('Saldo stok', () => tx.stockBalance.deleteMany(w));
    await del('Item VO', () => tx.variationOrderItem.deleteMany(w));
    await del('Variation order', () => tx.variationOrder.deleteMany(w));
    await del('Keputusan approval', () => tx.approvalDecision.deleteMany(w));
    await del('Permintaan approval', () => tx.approvalRequest.deleteMany(w));
    await del('Baris jurnal', () => tx.journalLine.deleteMany(w));
    await del('Jurnal', () => tx.journalEntry.deleteMany(w));
    await del('Penerimaan pelanggan', () => tx.customerReceipt.deleteMany(w));
    await del('Invoice pelanggan', () => tx.customerInvoice.deleteMany(w));
    await del('Pembayaran supplier', () => tx.supplierPayment.deleteMany(w));
    await del('Invoice supplier', () => tx.supplierInvoice.deleteMany(w));
    await del('Baris penerimaan barang', () => tx.goodsReceiptLine.deleteMany(w));
    await del('Penerimaan barang', () => tx.goodsReceipt.deleteMany(w));
    await del('Item PO', () => tx.purchaseOrderItem.deleteMany(w));
    await del('Purchase order', () => tx.purchaseOrder.deleteMany(w));
    await del('Item PR', () => tx.purchaseRequestItem.deleteMany(w));
    await del('Purchase request', () => tx.purchaseRequest.deleteMany(w));
    await del('Biaya proyek', () => tx.projectCost.deleteMany(w));
    await del('Item RAP/budget', () => tx.budgetItem.deleteMany(w));
    await del('RAP/budget', () => tx.budget.deleteMany(w));
    await del('Item RAB', () => tx.bqItem.deleteMany(w));
    await del('Progres', () => tx.progressEntry.deleteMany(w));
    await del('Laporan harian', () => tx.dailyReport.deleteMany(w));
    await del('Perawatan aset', () => tx.assetMaintenance.deleteMany(w));
    await del('Mutasi aset', () => tx.assetMovement.deleteMany(w));
    if (opts.master) {
      await del('Aset', () => tx.asset.deleteMany(w));
      await del('Master barang', () => tx.inventoryItem.deleteMany(w));
      await del('Gudang', () => tx.warehouse.deleteMany(w));
    } else {
      // aset & gudang tetap ada, tetapi tidak lagi terikat ke proyek yang dihapus
      await tx.asset.updateMany({ where: { tenantId, projectId: { not: null } }, data: { projectId: null } });
      await tx.warehouse.updateMany({ where: { tenantId, projectId: { not: null } }, data: { projectId: null } });
    }
    await del('Proyek', () => tx.project.deleteMany(w));
    await del('Item tender', () => tx.tenderItem.deleteMany(w));
    await del('Tender', () => tx.tender.deleteMany(w));
    if (opts.master) {
      await del('Customer', () => tx.customer.deleteMany(w));
      await del('Supplier', () => tx.supplier.deleteMany(w));
    }
    await del('Penomoran dokumen', () => tx.sequenceCounter.deleteMany(w));
    await del('Audit log', () => tx.auditLog.deleteMany(w));
  }, { timeout: 120_000, maxWait: 10_000 });
  return done;
}
