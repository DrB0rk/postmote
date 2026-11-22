#include <stdio.h>
#include <string.h>
#include <nss.h>
#include <pk11pub.h>
#include <pk11sdr.h>
#include <secitem.h>

int main(int argc, char **argv) {
  if ((argc != 3 && argc != 4) || NSS_InitReadWrite(argv[1]) != SECSuccess) return 1;
  PK11SlotInfo *slot = PK11_GetInternalKeySlot();
  if (!slot || PK11_CheckUserPassword(slot, argc == 4 ? argv[3] : "") != SECSuccess) return 2;
  SECItem key = {siBuffer, NULL, 0};
  SECItem input = {siBuffer, (unsigned char *)argv[2], (unsigned int)strlen(argv[2])};
  SECItem output = {siBuffer, NULL, 0};
  if (PK11SDR_Encrypt(&key, &input, &output, NULL) != SECSuccess) return 3;
  size_t written = fwrite(output.data, 1, output.len, stdout);
  SECITEM_ZfreeItem(&output, PR_FALSE);
  PK11_FreeSlot(slot);
  NSS_Shutdown();
  return written ? 0 : 4;
}
