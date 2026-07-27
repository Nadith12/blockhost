using System.Text.Json;
using LibreHardwareMonitor.Hardware;

var jsonOptions = new JsonSerializerOptions(JsonSerializerDefaults.Web)
{
    WriteIndented = false
};

try
{
    var computer = new Computer
    {
        IsCpuEnabled = true
    };

    try
    {
        computer.Open();
        computer.Accept(new UpdateVisitor());

        var sensors = computer.Hardware
            .Where(hardware => hardware.HardwareType == HardwareType.Cpu)
            .SelectMany(GetTemperatureSensors)
            .Where(sensor => sensor.Value is > 0 and < 130)
            .OrderBy(sensor => sensor.Name)
            .ToList();

        if (sensors.Count == 0)
        {
            Console.WriteLine(JsonSerializer.Serialize(
                new
                {
                    ok = false,
                    error = "No CPU temperature sensors found"
                },
                jsonOptions));
            return;
        }

        var preferredSensor = sensors.FirstOrDefault(sensor =>
            sensor.Name.Contains("package", StringComparison.OrdinalIgnoreCase) ||
            sensor.Name.Contains("tctl", StringComparison.OrdinalIgnoreCase) ||
            sensor.Name.Contains("tdie", StringComparison.OrdinalIgnoreCase));

        Console.WriteLine(JsonSerializer.Serialize(
            new CpuTemperatureResult
            {
                Ok = true,
                CpuTemp = Round(preferredSensor?.Value ?? sensors.Max(sensor => sensor.Value)),
                Sensors = sensors
                    .Select(sensor => new CpuTemperatureSensor
                    {
                        Name = sensor.Name,
                        Value = Round(sensor.Value)
                    })
                    .ToList()
            },
            jsonOptions));
    }
    finally
    {
        computer.Close();
    }
}
catch (Exception exception)
{
    Console.WriteLine(JsonSerializer.Serialize(
        new
        {
            ok = false,
            error = exception.Message
        },
        jsonOptions));
}

static IEnumerable<CpuTemperatureSensor> GetTemperatureSensors(IHardware hardware)
{
    hardware.Update();

    foreach (var sensor in hardware.Sensors)
    {
        if (sensor.SensorType == SensorType.Temperature && sensor.Value is not null)
        {
            yield return new CpuTemperatureSensor
            {
                Name = sensor.Name,
                Value = sensor.Value.Value
            };
        }
    }

    foreach (var subHardware in hardware.SubHardware)
    {
        foreach (var sensor in GetTemperatureSensors(subHardware))
        {
            yield return sensor;
        }
    }
}

static float Round(float value)
{
    return MathF.Round(value, 1);
}

public sealed record CpuTemperatureResult
{
    public bool Ok { get; init; }
    public float? CpuTemp { get; init; }
    public List<CpuTemperatureSensor> Sensors { get; init; } = [];
    public string? Error { get; init; }
}

public sealed record CpuTemperatureSensor
{
    public string Name { get; init; } = "";
    public float Value { get; init; }
}

public sealed class UpdateVisitor : IVisitor
{
    public void VisitComputer(IComputer computer)
    {
        computer.Traverse(this);
    }

    public void VisitHardware(IHardware hardware)
    {
        hardware.Update();

        foreach (var subHardware in hardware.SubHardware)
        {
            subHardware.Accept(this);
        }
    }

    public void VisitSensor(ISensor sensor)
    {
    }

    public void VisitParameter(IParameter parameter)
    {
    }
}
