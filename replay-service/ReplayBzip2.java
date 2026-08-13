import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import org.apache.commons.compress.compressors.bzip2.BZip2CompressorInputStream;

public final class ReplayBzip2 {
  private ReplayBzip2() {}

  public static void main(String[] args) throws Exception {
    if (args.length != 2) throw new IllegalArgumentException("usage: ReplayBzip2 INPUT OUTPUT");
    try (
      var input = new BZip2CompressorInputStream(new BufferedInputStream(Files.newInputStream(Path.of(args[0]))));
      var output = new BufferedOutputStream(Files.newOutputStream(Path.of(args[1])))
    ) {
      input.transferTo(output);
    }
  }
}
